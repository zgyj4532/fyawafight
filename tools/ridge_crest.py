"""给山脊 v2 的平顶加自然起伏（第二版）。

第一版用三个整数频率正弦叠加，出来是规整的锯齿墙 —— 因为整数频率相加必然周期化。
改用**一维值噪声**：不规则间距的控制点 + smoothstep 插值 + 三个非整数比倍频，
峰值归一化到 1.0（不会比原模型更高），底部锚在 ymin（始终贴地）。

其他要点：
1. 原位改写 POSITION / NORMAL bufferView，JSON 其余与贴图原样保留。
2. **不重算法线**：v2 的大平面观感来自烘焙法线，从低模重算会毁掉。用形变的雅可比
   矩阵 (J^-1)^T 旋转原法线，只补偿拉伸。雅可比用中心差分。
3. 噪声表预计算成 2048 点并固定，保证 deform() 在雅可比差分中多次调用结果一致。
"""
import json, struct, sys
import numpy as np

SRC = sys.argv[1] if len(sys.argv) > 1 else 'models/env-run/body/hill_ridge_v2.opt.glb'
DST = sys.argv[2] if len(sys.argv) > 2 else 'models/env-run/body/hill_ridge_v3.opt.glb'

# --- 起伏参数 ---
OCTAVES = [(1.60, 0.55, 11), (3.30, 0.30, 27), (6.10, 0.15, 43)]  # (频率, 权重, 种子)
AMP = 0.225                 # 总起伏幅度（相对原高）
H_FLOOR = 0.66              # 最低降到原高的比例
SADDLES = [(0.30, 0.085, 0.09), (0.74, 0.070, 0.07)]   # 一处较宽的鞍部
Z_SNAKE, Z_FREQ, Z_PH = 0.010, 2.70, 0.40          # z 向蛇形，破掉直棱
TOP_AMP = 0.032             # 顶面细起伏（相对原高）
TAPER = 0.0                # 横截面收分：顶部深度是底部的 (1-TAPER)，把棱柱变成斜坡

N_TABLE = 2048
T_GRID = np.linspace(0.0, 1.0, N_TABLE)


def value_noise(t_grid, freq, seed):
    """1D 值噪声：控制点间距 = 1/freq，smoothstep 插值。固定种子，结果可复现。"""
    rng = np.random.default_rng(seed)
    knots = rng.random(int(np.ceil(freq)) + 3) * 2.0 - 1.0
    u = t_grid * freq
    i0 = np.floor(u).astype(int)
    f = u - i0
    s = f * f * (3.0 - 2.0 * f)          # smoothstep，C1 连续
    return knots[i0] * (1 - s) + knots[i0 + 1] * s


def build_table():
    acc = np.zeros(N_TABLE)
    for freq, weight, seed in OCTAVES:
        acc += value_noise(T_GRID, freq, seed) * weight
    h = 1.0 + AMP * acc / sum(w for _, w, _ in OCTAVES)
    for st, sw, sd in SADDLES:
        h = h - sd * np.exp(-((T_GRID - st) / sw) ** 2)
    np.clip(h, H_FLOOR, None, out=h)
    return h / h.max()


H_TABLE = build_table()
# 顶面细起伏用另一套更高频的噪声，和主起伏不同源，避免两者同步
TF_TABLE = value_noise(T_GRID, 7.40, 97)

raw = open(SRC, 'rb').read()
jlen = struct.unpack('<I', raw[12:16])[0]
gltf = json.loads(raw[20:20 + jlen])
bin_start = 20 + jlen + 8
prim = gltf['meshes'][0]['primitives'][0]


def acc_info(idx):
    a = gltf['accessors'][idx]
    bv = gltf['bufferViews'][a['bufferView']]
    return a, bin_start + bv.get('byteOffset', 0) + a.get('byteOffset', 0)


a_pos, o_pos = acc_info(prim['attributes']['POSITION'])
a_nrm, o_nrm = acc_info(prim['attributes']['NORMAL'])

pos = np.frombuffer(raw, dtype='<f4', count=a_pos['count'] * 3, offset=o_pos).reshape(-1, 3).astype(np.float64)
nrm = np.frombuffer(raw, dtype='<f4', count=a_nrm['count'] * 3, offset=o_nrm).reshape(-1, 3).astype(np.float64)

xmin, xmax = pos[:, 0].min(), pos[:, 0].max()
ymin, ymax = pos[:, 1].min(), pos[:, 1].max()
L, H = xmax - xmin, ymax - ymin
ZC = (pos[:, 2].min() + pos[:, 2].max()) * 0.5
print(f'原始 {L:.3f} × {H:.3f} × {pos[:,2].max()-pos[:,2].min():.3f} m | 顶点 {len(pos)}')


def deform(p):
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    t = np.clip((x - xmin) / L, 0.0, 1.0)
    h = np.interp(t, T_GRID, H_TABLE)

    w = np.clip((y - ymin) / H - 0.55, 0.0, 1.0) / 0.45
    top = TOP_AMP * H * np.interp(t, T_GRID, TF_TABLE) * w

    ynew = ymin + (y - ymin) * h + top
    # 收分按变形后的相对高度算，顶部才会真的窄下去
    yn = np.clip((ynew - ymin) / (H * 1.05), 0.0, 1.0)
    znew = ZC + (z - ZC) * (1.0 - TAPER * yn)

    return np.stack([
        x,
        ynew,
        znew + Z_SNAKE * np.sin(2 * np.pi * Z_FREQ * t + Z_PH),
    ], axis=-1)


new_pos = deform(pos)

eps = 1e-5
J = np.empty((len(pos), 3, 3))
for k in range(3):
    d = np.zeros(3)
    d[k] = eps
    J[:, :, k] = (deform(pos + d) - deform(pos - d)) / (2 * eps)

new_nrm = np.einsum('ni,nij->nj', nrm, np.linalg.inv(J))
ln = np.linalg.norm(new_nrm, axis=1, keepdims=True)
ln[ln < 1e-12] = 1.0
new_nrm = new_nrm / ln

print(f'新高 {new_pos[:,1].max()-new_pos[:,1].min():.3f} m | '
      f'高度系数 {H_TABLE.min():.3f}..1.000 | 起伏峰谷差与原高之比 {(1-H_TABLE.min())*100:.0f}%')

out = bytearray(raw)
out[o_pos:o_pos + a_pos['count'] * 12] = new_pos.astype('<f4').tobytes()
out[o_nrm:o_nrm + a_nrm['count'] * 12] = new_nrm.astype('<f4').tobytes()

a_pos['min'] = [float(v) for v in new_pos.min(axis=0)]
a_pos['max'] = [float(v) for v in new_pos.max(axis=0)]

new_json = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
new_json += b' ' * ((4 - len(new_json) % 4) % 4)
bin_chunk = bytes(out[bin_start:])
bin_chunk += b'\x00' * ((4 - len(bin_chunk) % 4) % 4)

out_bytes = (struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(new_json) + 8 + len(bin_chunk))
             + struct.pack('<I4s', len(new_json), b'JSON') + new_json
             + struct.pack('<I4s', len(bin_chunk), b'BIN\x00') + bin_chunk)

open(DST, 'wb').write(out_bytes)
print(f'-> {DST}  {len(raw)/1024:.0f} KB -> {len(out_bytes)/1024:.0f} KB')

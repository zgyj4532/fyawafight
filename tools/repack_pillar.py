"""遗迹柱 v2 本地重排（0 点）：把三件从「三个零件摊开」改成「一座倒塌的门廊」。

v2 实测三个问题（按顶点位置焊接后求连通块，共 3 块）：

| 块 | 尺寸 (x, y, z) | ymin | 判定 |
| --- | --- | --- | --- |
| A 墙 | 1.758 × 0.869 × 0.380 | -1.249 | 落地 |
| B 高柱 | 0.695 × 2.500 × 0.705 | -1.250 | 落地 |
| C 短柱 | 0.666 × 1.296 × 0.644 | **-0.292** | **悬空 0.96 m** |

也就是说除了「摆得开」，还有一件是飘在空中的 —— 之前只量了整体包围盒，
没量每件的 ymin，漏了。

本脚本只做刚体位移（短柱额外加 9° 偏航），不动拓扑、不动贴图、不重算法线
（只对偏航的那件做同样的 Y 轴旋转）。

布局：墙在远端（-z），两根柱在近端（+z）贴墙立起，间隙 0.09 m。
俯视投影成一个 1.93 × 1.18 m 的连续团块，而不是三块散件。

用法：python tools/repack_pillar.py <src.glb> <dst.glb>
"""
import json, struct, sys
import numpy as np

SRC = sys.argv[1] if len(sys.argv) > 1 else 'models/env-run/body/ruins_pillar_v2.opt.glb'
DST = sys.argv[2] if len(sys.argv) > 2 else 'models/env-run/body/ruins_pillar_v3.glb'
MODE = sys.argv[3] if len(sys.argv) > 3 else 'portico_far'

# --- 三种候选布局（米）---
# portico_far  : 墙在远端（-z），两柱在近端贴墙立起 —— 俯视看到两柱，墙夹在中间
# portico_near : 墙在近端（+z），两柱在远端 —— 看到完整墙面，柱从墙后升起
# colonnade    : 柱-墙-柱 共线成一条，间隙 0.08 —— 一条带两端的柱廊
GAP = 0.08
SHORT_YAW = 9.0       # 短柱偏航角度（度），避免两根一模一样

LAYOUT = {
    'portico_far':  dict(wall_z=-0.10, col_z=+0.44, col_x=0.60),
    'portico_near': dict(wall_z=+0.19, col_z=-0.44, col_x=0.60),
    'colonnade':    dict(wall_z=0.0, col_z=0.0, col_x=None),
}
CFG = LAYOUT[MODE]

# ---------- 解析 GLB ----------
raw = open(SRC, 'rb').read()
_, _, total = struct.unpack('<III', raw[:12])
off, chunks = 12, []
while off < total:
    clen, ctype = struct.unpack('<II', raw[off:off + 8])
    chunks.append((ctype, raw[off + 8:off + 8 + clen]))
    off += 8 + clen
J = json.loads(chunks[0][1].decode('utf-8'))
BIN = bytearray(chunks[1][1])

CT = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2),
      5125: ('I', 4), 5126: ('f', 4)}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def acc_off(i):
    a = J['accessors'][i]
    bv = J['bufferViews'][a['bufferView']]
    fmt, sz = CT[a['componentType']]
    n = NC[a['type']]
    return (bv.get('byteOffset', 0) + a.get('byteOffset', 0),
            bv.get('byteStride') or sz * n, fmt, n, a)


prim = J['meshes'][0]['primitives'][0]
POS_I = prim['attributes']['POSITION']
NRM_I = prim['attributes']['NORMAL']
IDX_I = prim['indices']

p_off, p_stride, p_fmt, p_n, p_acc = acc_off(POS_I)
n_off, n_stride, n_fmt, n_n, n_acc = acc_off(NRM_I)
i_off, _, i_fmt, _, i_acc = acc_off(IDX_I)

CNT = p_acc['count']
pos = np.array([struct.unpack_from('<' + p_fmt * 3, BIN, p_off + k * p_stride)
                for k in range(CNT)], dtype=np.float64)
nrm = np.array([struct.unpack_from('<' + n_fmt * 3, BIN, n_off + k * n_stride)
                for k in range(CNT)], dtype=np.float64)
idx = np.frombuffer(BIN, dtype=np.dtype('<' + i_fmt), count=i_acc['count'],
                    offset=i_off).astype(np.int64)

# ---------- 焊接 + 连通块 ----------
key = np.round(pos * 1e4).astype(np.int64)
_, weld = np.unique(key, axis=0, return_inverse=True)
weld = weld.ravel()
NW = int(weld.max()) + 1
tri = weld[idx.reshape(-1, 3)]

parent = np.arange(NW, dtype=np.int64)


def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


for a, b in ((0, 1), (1, 2), (2, 0)):
    for u, v in zip(tri[:, a], tri[:, b]):
        ru, rv = find(int(u)), find(int(v))
        if ru != rv:
            parent[ru] = rv
roots = np.array([find(i) for i in range(NW)])
uniq, counts = np.unique(roots, return_counts=True)
order = np.argsort(-counts)
KEEP = uniq[order][:3]
if len(uniq) != 3:
    print(f'警告：连通块数 = {len(uniq)}，只取最大的 3 块')

comp = np.full(NW, -1, dtype=np.int64)
for ci, r in enumerate(KEEP):
    comp[roots == r] = ci
vcomp = comp[weld]          # 原顶点 -> 块编号


def bbox(pid):
    m = vcomp == pid
    p = pos[m]
    return p.min(0), p.max(0)


info = []
for ci in range(3):
    mn, mx = bbox(ci)
    info.append({'id': ci, 'min': mn, 'max': mx, 'size': mx - mn,
                 'v': int((vcomp == ci).sum())})
    print(f'块{ci}: size={(mx - mn).round(3)} ymin={mn[1]:.3f} v={info[-1]["v"]}')

# 分类：最高的那块是高柱；最扁且最长的（y 最小）是墙；剩下的是短柱
by_h = sorted(info, key=lambda d: -d['size'][1])
TALL = by_h[0]['id']
rest = [d for d in info if d['id'] != TALL]
WALL = min(rest, key=lambda d: d['size'][1])['id']
SHORT = [d for d in rest if d['id'] != WALL][0]['id']
print(f'分类：墙={WALL} 高柱={TALL} 短柱={SHORT}')

# 地面 = 落地件的最低点（-1.25）；短柱原本 ymin=-0.292，会被放下来
GY = min(d['min'][1] for d in info)
print(f'地面 y = {GY:.3f}')

# ---------- 摆位 ----------
if MODE == 'colonnade':
    # 沿 x 依次排：高柱 · 墙 · 短柱，间隙 GAP，z 全部对齐
    order = [(TALL, info[TALL]['size'][0]), (WALL, info[WALL]['size'][0]),
             (SHORT, info[SHORT]['size'][0])]
    total = sum(w for _, w in order) + GAP * (len(order) - 1)
    cur = -total / 2
    target = {}
    for cid, w in order:
        target[cid] = dict(cx=cur + w / 2, cz=CFG['wall_z'],
                           yaw=SHORT_YAW if cid == SHORT else 0.0)
        cur += w + GAP
else:
    target = {
        WALL: dict(cx=0.0, cz=CFG['wall_z'], yaw=0.0),
        TALL: dict(cx=-CFG['col_x'], cz=CFG['col_z'], yaw=0.0),
        SHORT: dict(cx=+CFG['col_x'], cz=CFG['col_z'], yaw=SHORT_YAW),
    }

new_pos = pos.copy()
new_nrm = nrm.copy()

for cid, t in target.items():
    m = vcomp == cid
    p = pos[m]
    mn, mx = p.min(0), p.max(0)
    cx, cz = (mn[0] + mx[0]) / 2, (mn[2] + mx[2]) / 2
    th = np.radians(t['yaw'])
    ca, sa = np.cos(th), np.sin(th)
    dx = p[:, 0] - cx
    dz = p[:, 2] - cz
    rx = cx + dx * ca + dz * sa
    rz = cz - dx * sa + dz * ca
    # 旋转后重新量包围盒，再平移到目标位置
    rmn_x, rmx_x = rx.min(), rx.max()
    rmn_z, rmx_z = rz.min(), rz.max()
    tx = t['cx'] - (rmn_x + rmx_x) / 2
    tz = t['cz'] - (rmn_z + rmx_z) / 2
    ty = GY - mn[1]                      # 落地
    new_pos[m, 0] = rx + tx
    new_pos[m, 1] = p[:, 1] + ty
    new_pos[m, 2] = rz + tz
    # 法线只做 Y 轴旋转
    nx_, nz_ = nrm[m][:, 0], nrm[m][:, 2]
    new_nrm[m, 0] = nx_ * ca + nz_ * sa
    new_nrm[m, 2] = -nx_ * sa + nz_ * ca
    print(f'块{cid} -> 平移 ({tx:+.3f}, {ty:+.3f}, {tz:+.3f}) yaw={t["yaw"]}°')

# ---------- 写回 ----------
for k in range(CNT):
    struct.pack_into('<' + p_fmt * 3, BIN, p_off + k * p_stride, *new_pos[k])
    struct.pack_into('<' + n_fmt * 3, BIN, n_off + k * n_stride, *new_nrm[k])

mn, mx = new_pos.min(0), new_pos.max(0)
J['accessors'][POS_I]['min'] = [float(v) for v in mn]
J['accessors'][POS_I]['max'] = [float(v) for v in mx]

jb = json.dumps(J, separators=(',', ':')).encode('utf-8')
jb += b' ' * ((4 - len(jb) % 4) % 4)
bb = bytes(BIN)
bb += b'\x00' * ((4 - len(bb) % 4) % 4)
out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(jb) + 8 + len(bb))
out += struct.pack('<II', len(jb), 0x4E4F534A) + jb
out += struct.pack('<II', len(bb), 0x004E4942) + bb
open(DST, 'wb').write(out)

print(f'\nbbox min={mn.round(3)} max={mx.round(3)} size={(mx - mn).round(3)}')
print(f'{SRC} -> {DST}  {len(out) / 1e6:.2f} MB')

"""拆 component 看遗迹柱 v2 的三件到底多大、摆多开。

只读，不写文件。按三角形连通性做并查集（顶点位置精确相等才算连着，
Lux3D 输出是焊好的网格，不做容差合并）。
"""
import json, struct, sys
import numpy as np

SRC = sys.argv[1] if len(sys.argv) > 1 else 'models/env/body/ruins_pillar.glb'

raw = open(SRC, 'rb').read()
magic, ver, total = struct.unpack('<III', raw[:12])
off = 12
chunks = []
while off < total:
    clen, ctype = struct.unpack('<II', raw[off:off + 8])
    chunks.append((ctype, raw[off + 8:off + 8 + clen]))
    off += 8 + clen
J = json.loads(chunks[0][1].decode('utf-8'))
BIN = chunks[1][1]

CT = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2),
      5125: ('I', 4), 5126: ('f', 4)}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_acc(i):
    a = J['accessors'][i]
    bv = J['bufferViews'][a['bufferView']]
    fmt, sz = CT[a['componentType']]
    n = NC[a['type']]
    start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride') or sz * n
    cnt = a['count']
    out = np.empty((cnt, n), dtype=fmt)
    if stride == sz * n:
        buf = np.frombuffer(BIN, dtype=fmt, count=cnt * n, offset=start)
        out = buf.reshape(cnt, n)
    else:
        for k in range(cnt):
            out[k] = np.frombuffer(BIN, dtype=fmt, count=n, offset=start + k * stride)
    return out


print(f'file={SRC}  meshes={len(J.get("meshes", []))} nodes={len(J.get("nodes", []))}')
for mi, m in enumerate(J['meshes']):
    print(f' mesh[{mi}] name={m.get("name")} primitives={len(m["primitives"])}')
    for pi, p in enumerate(m['primitives']):
        pos = read_acc(p['attributes']['POSITION']).astype(np.float64)
        idx = read_acc(p['indices']).ravel().astype(np.int64) if 'indices' in p else \
            np.arange(len(pos))
        tri = idx.reshape(-1, 3)
        print(f'  prim[{pi}] tris={len(tri)} verts={len(pos)}')
        print(f'   bbox min={pos.min(0).round(3)} max={pos.max(0).round(3)}'
              f' size={(pos.max(0) - pos.min(0)).round(3)}')

        # 先按位置焊接：Lux3D 输出的 UV 接缝会把同一个顶点拆成多份，
        # 只按 index 求连通性会碎成几百片。量化到 1e-4 m 后重新映射。
        key = np.round(pos * 1e4).astype(np.int64)
        _, weld = np.unique(key, axis=0, return_inverse=True)
        weld = weld.ravel()
        nw = weld.max() + 1
        tri = weld[tri]
        wpos = np.zeros((nw, 3))
        for d in range(3):
            wpos[:, d] = np.bincount(weld, weights=pos[:, d], minlength=nw) / \
                np.maximum(np.bincount(weld, minlength=nw), 1)
        print(f'   welded verts {len(pos)} -> {nw}')
        pos = wpos

        # 并查集
        parent = np.arange(len(pos), dtype=np.int64)

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
        roots = np.array([find(int(i)) for i in range(len(pos))])
        uniq, counts = np.unique(roots, return_counts=True)
        order = np.argsort(-counts)
        print(f'   components={len(uniq)}')
        used = np.zeros(len(pos), bool)
        for k in order[:12]:
            r = uniq[k]
            mask = roots == r
            used |= mask
            p = pos[mask]
            mn, mx = p.min(0), p.max(0)
            vc = counts[k]
            print(f'     comp v={vc:6d} ({100.0 * vc / len(pos):5.1f}%) '
                  f'size={(mx - mn).round(3)} center={((mn + mx) / 2).round(3)} '
                  f'ymin={mn[1]:.3f}')

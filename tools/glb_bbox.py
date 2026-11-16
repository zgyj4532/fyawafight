"""量一批 GLB 的整体包围盒（米）与三角数。

读 accessor 自带的 min/max：Lux3D 输出是单 mesh、单 node，
转成非索引也能对上，够用。需要拆件时用 tools/glb_inspect_parts.py。
"""
import json, struct, sys, pathlib

CT = {5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def parse(path):
    raw = pathlib.Path(path).read_bytes()
    magic, ver, total = struct.unpack('<III', raw[:12])
    off = 12
    js, bin_ = None, None
    while off < total:
        clen, ctype = struct.unpack('<II', raw[off:off + 8])
        chunk = raw[off + 8:off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode('utf-8'))
        else:
            bin_ = chunk
        off += 8 + clen
    return js, bin_


for arg in sys.argv[1:]:
    p = pathlib.Path(arg)
    J, B = parse(p)
    lo = [1e9] * 3
    hi = [-1e9] * 3
    tris = 0
    for mesh in J.get('meshes', []):
        for prim in mesh['primitives']:
            acc = J['accessors'][prim['attributes']['POSITION']]
            for i in range(3):
                lo[i] = min(lo[i], acc['min'][i])
                hi[i] = max(hi[i], acc['max'][i])
            if 'indices' in prim:
                tris += J['accessors'][prim['indices']]['count'] // 3
            else:
                tris += acc['count'] // 3
    size = [round(hi[i] - lo[i], 3) for i in range(3)]
    print(f'{p.name:28s} {size[0]:6.3f} x {size[1]:6.3f} x {size[2]:6.3f}  '
          f'y_min={lo[1]:+.3f}  tris={tris:6d}  nodes={len(J.get("nodes", []))}')

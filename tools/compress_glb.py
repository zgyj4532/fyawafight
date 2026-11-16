"""压缩 Lux3D 输出的 GLB。

体积构成实测：每个模型 3 张 2048² 贴图，占 90%+。而 js/pipeline.js 的
convertToToon() 只读 mat.map（baseColor），normal 和 metallicRoughness 进
游戏后完全不会被采样。所以这里：

  1. baseColor 降到 1024² 并重编码为 JPEG q80
  2. 另外两张替换成 1×1 占位图（保留 bufferView 索引，避免重映射全部引用）
  3. material 里删掉 normal / metallicRoughness / occlusion 三个槽

不改几何，不改 accessor，不动顶点数据 —— 只重写 image 的字节。
"""
import io, json, struct, sys, pathlib
from PIL import Image

MAX_TEX = 1024
QUALITY = 80


def load_glb(path):
    b = pathlib.Path(path).read_bytes()
    magic, ver, total = struct.unpack('<4sII', b[:12])
    assert magic == b'glTF' and ver == 2, 'not a GLB2'
    off = 12
    chunks = []
    while off < total:
        clen, ctype = struct.unpack('<II', b[off:off + 8])
        chunks.append((ctype, b[off + 8: off + 8 + clen]))
        off += 8 + clen
    j = json.loads(chunks[0][1].decode('utf-8'))
    bin_data = chunks[1][1] if len(chunks) > 1 else b''
    return j, bin_data


def save_glb(path, j, bin_data):
    jbytes = json.dumps(j, separators=(',', ':')).encode('utf-8')
    jbytes += b' ' * ((4 - len(jbytes) % 4) % 4)
    bin_data += b'\x00' * ((4 - len(bin_data) % 4) % 4)
    total = 12 + 8 + len(jbytes) + 8 + len(bin_data)
    out = bytearray()
    out += struct.pack('<4sII', b'glTF', 2, total)
    out += struct.pack('<II', len(jbytes), 0x4E4F534A) + jbytes
    out += struct.pack('<II', len(bin_data), 0x004E4942) + bin_data
    pathlib.Path(path).write_bytes(bytes(out))


def main(src, dst):
    j, bin_data = load_glb(src)

    used_views = set()
    for m in j.get('materials', []):
        pbr = m.get('pbrMetallicRoughness', {})
        bc = pbr.get('baseColorTexture')
        if bc:
            used_views.add(j['textures'][bc['index']]['source'])
        for slot in ('metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture'):
            holder = pbr if slot == 'metallicRoughnessTexture' else m
            if slot in holder:
                holder.pop(slot, None)

    # 每张图：baseColor 降采样，其余压成 1×1
    new_images = {}
    for i, im in enumerate(j.get('images', [])):
        bv = j['bufferViews'][im['bufferView']]
        start = bv.get('byteOffset', 0)
        raw = bin_data[start: start + bv['byteLength']]
        pil = Image.open(io.BytesIO(raw))
        if i in used_views:
            pil = pil.convert('RGB')
            if max(pil.size) > MAX_TEX:
                k = MAX_TEX / max(pil.size)
                pil = pil.resize((max(1, int(pil.width * k)), max(1, int(pil.height * k))), Image.LANCZOS)
            buf = io.BytesIO()
            pil.save(buf, 'JPEG', quality=QUALITY, optimize=True)
            data = buf.getvalue()
            im['mimeType'] = 'image/jpeg'
        else:
            buf = io.BytesIO()
            Image.new('RGB', (1, 1), (255, 255, 255)).save(buf, 'JPEG', quality=60)
            data = buf.getvalue()
            im['mimeType'] = 'image/jpeg'
        new_images[i] = data

    # 重建 BIN：保持 bufferView 索引与顺序，只替换图片数据
    img_view = {im['bufferView']: i for i, im in enumerate(j.get('images', []))}
    offsets = {}
    pieces = []
    cursor = 0

    def add(payload, align=4):
        nonlocal cursor
        pad = (align - cursor % align) % align
        if pad:
            pieces.append(b'\x00' * pad)
            cursor += pad
        off = cursor
        pieces.append(payload)
        cursor += len(payload)
        return off

    for vi, bv in enumerate(j['bufferViews']):
        if vi in img_view:
            payload = new_images[img_view[vi]]
        else:
            start = bv.get('byteOffset', 0)
            payload = bin_data[start: start + bv['byteLength']]
        off = add(payload)
        offsets[vi] = (off, len(payload))

    for vi, bv in enumerate(j['bufferViews']):
        bv['byteOffset'], bv['byteLength'] = offsets[vi]

    new_bin = b''.join(pieces)
    j['buffers'] = [{'byteLength': len(new_bin)}]
    save_glb(dst, j, new_bin)

    return len(bin_data), len(new_bin)


if __name__ == '__main__':
    for name in sys.argv[1:]:
        src = pathlib.Path(name)
        dst = src.with_name(src.stem + '.opt.glb')
        a, b = main(str(src), str(dst))
        print(f'{src.name}: {a/1048576:.2f} MB -> {b/1048576:.2f} MB  ({dst.name})')

"""GLB 贴图压缩：重采样内嵌贴图并转 JPEG，重排 bufferView 偏移，输出可被 three.js 直接加载的 GLB。

用法：
  python optimize_glb.py <in.glb> <out.glb> [--max-size 1024] [--quality 88] [--format jpeg|png]
"""
import argparse
import io
import json
import os
import struct

from PIL import Image

GLB_MAGIC = 0x46546C67
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def read_glb(path):
    raw = open(path, "rb").read()
    magic, version, length = struct.unpack("<III", raw[:12])
    if magic != GLB_MAGIC:
        raise ValueError("not a GLB file")
    off, json_chunk, bin_chunk = 12, None, None
    while off < length:
        clen, ctype = struct.unpack("<II", raw[off:off + 8])
        off += 8
        data = raw[off:off + clen]
        off += clen
        if ctype == JSON_CHUNK:
            json_chunk = data
        elif ctype == BIN_CHUNK:
            bin_chunk = data
    return json.loads(json_chunk.decode("utf-8")), bin_chunk


def write_glb(path, gltf, bin_data):
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    bn = bin_data + b"\x00" * ((4 - len(bin_data) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(bn)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", GLB_MAGIC, 2, total))
        f.write(struct.pack("<II", len(js), JSON_CHUNK))
        f.write(js)
        f.write(struct.pack("<II", len(bn), BIN_CHUNK))
        f.write(bn)


def optimize(src, dst, max_size=1024, quality=88, fmt="jpeg"):
    gltf, bin_data = read_glb(src)
    images = gltf.get("images", [])
    if not images:
        raise SystemExit("no embedded images")

    replaced = {}
    report = []
    for idx, img in enumerate(images):
        bv_index = img.get("bufferView")
        if bv_index is None:
            continue
        bv = gltf["bufferViews"][bv_index]
        start = bv.get("byteOffset", 0)
        blob = bin_data[start:start + bv["byteLength"]]
        im = Image.open(io.BytesIO(blob))
        orig_w, orig_h = im.size
        scale = min(1.0, max_size / max(orig_w, orig_h))
        new_w, new_h = max(1, int(orig_w * scale)), max(1, int(orig_h * scale))
        if scale < 1.0:
            im = im.resize((new_w, new_h), Image.LANCZOS)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        buf = io.BytesIO()
        if fmt == "jpeg":
            im.save(buf, format="JPEG", quality=quality, optimize=True, progressive=False)
            img["mimeType"] = "image/jpeg"
        else:
            im.save(buf, format="PNG", optimize=True)
            img["mimeType"] = "image/png"
        replaced[bv_index] = buf.getvalue()
        report.append((idx, orig_w, orig_h, new_w, new_h, len(blob), len(buf.getvalue())))

    # 按 bufferView 顺序重排，保留未替换内容的原始字节
    out = bytearray()
    for i, bv in enumerate(gltf["bufferViews"]):
        start = bv.get("byteOffset", 0)
        data = replaced.get(i)
        if data is None:
            data = bin_data[start:start + bv["byteLength"]]
        pad = (4 - len(out) % 4) % 4
        out += b"\x00" * pad
        bv["byteOffset"] = len(out)
        bv["byteLength"] = len(data)
        out += data
    gltf["buffers"][0]["byteLength"] = len(out)

    write_glb(dst, gltf, bytes(out))
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--max-size", type=int, default=1024)
    ap.add_argument("--quality", type=int, default=88)
    ap.add_argument("--format", choices=["jpeg", "png"], default="jpeg")
    a = ap.parse_args()
    rep = optimize(a.src, a.dst, a.max_size, a.quality, a.format)
    before = os.path.getsize(a.src)
    after = os.path.getsize(a.dst)
    print(f"size {before/1048576:.2f}MB -> {after/1048576:.2f}MB ({after/before*100:.1f}%)")
    for idx, ow, oh, nw, nh, ob, nb in rep:
        print(f"  image{idx}: {ow}x{oh} {ob/1024:.0f}KB -> {nw}x{nh} {nb/1024:.0f}KB")


if __name__ == "__main__":
    main()

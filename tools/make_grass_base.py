"""Clean low-frequency grass base.

The current recolor kept the original blotchy structure, which reads as camo
when tiled at 8 m. This builds a fresh, seam-free base with only large scale
variation, so the ground provides colour and the geometry provides detail.

Run: python tools/make_grass_base.py
"""

import os

import numpy as np
from PIL import Image

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST = os.path.join(PROJECT, "settingimg", "env", "textures")
SIZE = 512

# Locked palette anchors, ordered by luminance target.
PALETTE = [
    (0.00, (0x33, 0x5E, 0x21)),
    (0.35, (0x46, 0x78, 0x27)),
    (0.62, (0x53, 0x88, 0x2B)),
    (0.84, (0x6B, 0x9E, 0x35)),
    (1.00, (0x86, 0xB8, 0x44)),
]


def value_noise(cells, size, rng, smooth=True):
    """Tileable value noise: random lattice upsampled with a cosine ramp."""
    grid = rng.random((cells, cells)).astype(np.float32)
    # Wrap so the tile repeats.
    grid = np.pad(grid, ((0, 1), (0, 1)), mode="wrap")
    ys = np.linspace(0, cells, size, endpoint=False, dtype=np.float32)
    xs = np.linspace(0, cells, size, endpoint=False, dtype=np.float32)
    y0 = np.floor(ys).astype(np.int32)
    x0 = np.floor(xs).astype(np.int32)
    fy = (ys - y0)[:, None]
    fx = (xs - x0)[None, :]
    if smooth:
        fy = 0.5 - 0.5 * np.cos(np.pi * fy)
        fx = 0.5 - 0.5 * np.cos(np.pi * fx)
    a = grid[np.ix_(y0, x0)]
    b = grid[np.ix_(y0, x0 + 1)]
    c = grid[np.ix_(y0 + 1, x0)]
    d = grid[np.ix_(y0 + 1, x0 + 1)]
    top = a * (1 - fx) + b * fx
    bottom = c * (1 - fx) + d * fx
    return top * (1 - fy) + bottom * fy


def fbm(size, rng):
    """Four octaves, weighted towards the low end so no blotches appear."""
    total = np.zeros((size, size), dtype=np.float32)
    weight = 0.0
    for cells, amp in ((8, 0.30), (16, 0.30), (32, 0.24), (64, 0.16)):
        total += value_noise(cells, size, rng) * amp
        weight += amp
    return total / weight


def build(name, rng, seed_shift, saturation=1.0, brightness=1.0):
    base = fbm(SIZE, rng)
    # Flatten the histogram so mid tones dominate; avoids dark camo patches.
    base = np.clip((base - base.mean()) / (base.std() + 1e-6) * 0.09 + 0.52, 0.0, 1.0)

    anchors = np.array([p[0] for p in PALETTE], dtype=np.float32)
    cols = np.array([p[1] for p in PALETTE], dtype=np.float32)
    out = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
    for ch in range(3):
        out[:, :, ch] = np.interp(base, anchors, cols[:, ch])

    # Fine grain: 1-2 % variation, enough to break banding, invisible as noise.
    grain = rng.normal(0.0, 0.030, (SIZE, SIZE, 1)).astype(np.float32)
    out = out * (1.0 + grain)

    # Saturation around per-pixel luminance. Using the channel means here would
    # drag all three channels to one grey and kill the hue.
    if saturation != 1.0:
        lum = out @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
        out = lum[:, :, None] + (out - lum[:, :, None]) * saturation
    out = out * brightness

    out = np.clip(out, 0, 255).astype(np.uint8)
    img = Image.fromarray(out)
    img.save(os.path.join(DST, f"{name}.png"), optimize=True)
    img.save(os.path.join(PROJECT, "models", "env", "textures", f"{name}.jpg"),
             quality=94, subsampling=1, optimize=True)

    a = out.astype(np.float32).reshape(-1, 3)
    L = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    gr = np.median((a[:, 1] + 1e-6) / np.maximum(a[:, 0], 1e-6))
    mx, mn = a.max(axis=1), a.min(axis=1)
    s = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0)
    # Seam check on the final tile.
    arr = np.asarray(img, dtype=np.float32)
    sh = np.abs(arr[:, 0] - arr[:, -1]).mean()
    sv = np.abs(arr[0, :] - arr[-1, :]).mean()
    print(f"{name:26s} L={L.mean():5.1f} 范围={np.percentile(L,95)-np.percentile(L,5):4.0f} "
          f"G:R={gr:.2f} 饱和={s.mean():.3f} 接缝h={sh:.2f} v={sv:.2f}")


def main():
    rng = np.random.default_rng(4242)
    build("env_base_grass", rng, 0)
    build("env_base_grass_b", rng, 1, brightness=1.04)


if __name__ == "__main__":
    main()

# 把 aholo 产出的方形纹章图转成透明底 PNG，并裁到盾形包围盒。
# 背景是均匀深灰，按颜色距离抠掉；盾内没有接近背景色的区域，风险低。
import numpy as np
from PIL import Image, ImageFilter

SRC = 'assets/emblem_knight_raw.jpg'
DST = 'assets/emblem_knight.png'
SIZE = 512
THRESH = 34.0

im = Image.open(SRC).convert('RGB')
a = np.asarray(im).astype(np.float32)

# 四角均值当背景色
h, w, _ = a.shape
corners = np.concatenate([a[:40, :40].reshape(-1, 3), a[:40, -40:].reshape(-1, 3),
                          a[-40:, :40].reshape(-1, 3), a[-40:, -40:].reshape(-1, 3)])
bg = corners.mean(axis=0)
dist = np.linalg.norm(a - bg, axis=2)
alpha = np.where(dist < THRESH, 0, 255).astype(np.uint8)

rgba = np.dstack([np.asarray(im).astype(np.uint8), alpha])
img = Image.fromarray(rgba, 'RGBA')

# 羽化 1px，去锯齿
alpha_img = img.getchannel('A').filter(ImageFilter.GaussianBlur(0.8))
img.putalpha(alpha_img)

bbox = alpha_img.getbbox()
img = img.crop(bbox)

# 居中到正方形画布，留 3% 边距
side = int(max(img.size) * 1.06)
canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
canvas = canvas.resize((SIZE, SIZE), Image.LANCZOS)
canvas.save(DST, optimize=True)

print('bg', bg.round(1).tolist(), 'bbox', bbox, '->', DST, canvas.size)

"""把若干张同尺寸截图拼成一张带标题的对照图。

用法：python tools/tile_shots.py out.png "标题1" a.png "标题2" b.png ...
每张按 3:2 等比缩放到统一格子，底部画标题条。
"""
import sys
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
pairs = [(sys.argv[i], sys.argv[i + 1]) for i in range(2, len(sys.argv), 2)]  # (label, path)

COLS = 3 if len(pairs) > 2 else len(pairs)
CELL_W, CELL_H = 520, 300
PAD = 6
TITLE_H = 26

rows = (len(pairs) + COLS - 1) // COLS
W = COLS * CELL_W + (COLS + 1) * PAD
H = rows * (CELL_H + TITLE_H) + (rows + 1) * PAD
canvas = Image.new('RGB', (W, H), (18, 18, 18))
draw = ImageDraw.Draw(canvas)


def cjk_font(size=17):
    """默认字体没有汉字，标题会全变成方框。按顺序找系统里的中文字体。"""
    for name in ('msyh.ttc', 'msyhbd.ttc', 'simhei.ttf', 'simsun.ttc'):
        try:
            return ImageFont.truetype('C:/Windows/Fonts/' + name, size)
        except OSError:
            continue
    return ImageFont.load_default()


FONT = cjk_font()

for i, (label, path) in enumerate(pairs):
    im = Image.open(path).convert('RGB')
    # 裁成 16:10 再缩放，避免非等比拉伸
    w, h = im.size
    target = CELL_W / CELL_H
    if w / h > target:
        nw = int(h * target)
        im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else:
        nh = int(w / target)
        im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    im = im.resize((CELL_W, CELL_H), Image.LANCZOS)
    c, r = i % COLS, i // COLS
    x = PAD + c * (CELL_W + PAD)
    y = PAD + r * (CELL_H + TITLE_H + PAD)
    canvas.paste(im, (x, y + TITLE_H))
    draw.text((x + 4, y + 4), label, fill=(232, 232, 232), font=FONT)

canvas.save(out)
print('ok', out, canvas.size)

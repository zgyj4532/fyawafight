"""摆位冲突检查：把叙事陈设和体量层摊在一张平面上，量两两之间的距离。

为什么需要它：两边的坐标都不是世界坐标，而是「沿路里程 + 侧向距离」，
而 `cx = x + (−s/len)·lateral` 里 lateral 会带动 x。所以"这两个东西隔多远"
不能看里程差，必须换算成世界坐标再量。

用法：python tools/check_layout.py
改完 js/narrative.js 的 SPOTS 或 js/scenery.js 的 TREES / ROCKS / GROVES / DEADS
之后跑一次，radius 是每件东西大致的半宽（米）。
"""
import math

A1, A2 = 6.5, 2.6
K1 = 4 * math.pi / 120
K2 = 2 * math.pi / 120


def center_z(x):
    return A1 * math.sin(K1 * x) + A2 * (math.cos(K2 * x) - 1)


def slope(x):
    return A1 * K1 * math.cos(K1 * x) - A2 * K2 * math.sin(K2 * x)


def place(x, lateral):
    s = slope(x)
    ln = math.sqrt(1 + s * s)
    return (x + (-s / ln) * lateral, center_z(x) + (1 / ln) * lateral)


# 叙事陈设：(名字, 里程, side, lateral, 半宽)
NARRATIVE = [
    ('campfire', 15.4, -1, 4.8, 0.6),
    ('well', 19.4, -1, 5.8, 1.4),
    ('cart', 23.0, -1, 6.4, 1.1),
    ('pillar', 27.6, 1, 6.2, 0.6),
    ('pillar', 32.6, 1, 5.2, 0.6),
    ('shield', 35.4, 1, 4.8, 0.45),
    ('gallows', 38.6, 1, 4.4, 1.5),
    ('cloak', 41.6, 1, 6.2, 0.5),
    ('skeleton', 45.4, 1, 3.6, 1.6),
    ('tower', -42, -1, 9.0, 1.4),
    ('arch', -35, 1, 0.4, 2.8),
    ('archLow', -31.0, -1, 6.4, 1.5),
    ('stones', -27.4, 1, 8.6, 1.4),
    ('well', -12, 1, 5.8, 1.4),
    ('pillar', -6.4, -1, 6.0, 0.6),
]

# 体量层：(名字, 里程, lateral, 半宽)  —— 一律在 −z 侧
SCENERY = [
    ('tree', -50, 9.2, 2.0),
    ('tree', -36, 10.4, 2.0),
    ('tree', -20, 8.8, 2.0),
    ('tree', 20, 9.4, 2.0),
    ('tree', 30, 10.6, 2.0),
    ('tree', 42, 10.2, 2.0),
    ('tree', 54, 9.4, 2.0),
    ('grove', -56, 10.2, 3.0),
    ('grove', -12, 10.8, 3.0),
    ('grove', 45, 10.4, 3.0),
    ('rocks', -46, 7.6, 0.9),
    ('rocks', -26, 9.4, 0.9),
    ('rocks', 1, 7.6, 0.9),
    ('rocks', 24, 9.0, 0.9),
    ('rocks', 36, 7.4, 0.9),
    ('rocks', 50, 8.6, 0.9),
    ('dead', -30, 11.0, 1.2),
    ('dead', -2, 12.0, 1.2),
    ('dead', 33.5, 9.8, 1.2),
    ('lake', 4.5, 12.4, 4.2),
]

n = [(r[0],) + place(r[1], r[2] * r[3]) + (r[4],) for r in NARRATIVE]
s = [(r[0],) + place(r[1], -r[2]) + (r[3],) for r in SCENERY]

bad = 0
for a in n:
    for b in s:
        d = math.hypot(a[1] - b[1], a[2] - b[2])
        if d < a[3] + b[3]:
            print(f'N/S {a[0]:<9} {b[0]:<6} d={d:.2f} (need {a[3] + b[3]:.1f})')
            bad += 1
for i in range(len(s)):
    for j in range(i + 1, len(s)):
        d = math.hypot(s[i][1] - s[j][1], s[i][2] - s[j][2])
        need = s[i][3] + s[j][3]
        if d < need:
            print(f'S/S {s[i][0]:<6} {s[j][0]:<6} d={d:.2f} (need {need:.1f})')
            bad += 1

print('conflicts', bad)

lc = place(4.5, -12.4)
best = min(math.hypot(lc[0] - k / 10, lc[1] - center_z(k / 10)) for k in range(-1200, 1201))
print(f'lake center {lc[0]:.2f},{lc[1]:.2f}  dist to centerline {best:.2f} m')

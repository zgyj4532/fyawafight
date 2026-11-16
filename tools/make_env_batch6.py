"""第六批：重做绞刑架（1 个物件）。

第三批的 gallows 读不出绞刑架，两个原因叠在一起：

1. **两根立柱是内倾的 A 字架。** 提示词只写了「两根立柱撑起一根横梁」，
   模型对"撑起"的默认理解是**斜撑**，于是顶部的间距被收窄到不足底部的一半。
   58° 俯视下这个收窄被压得更明显，整体读成"支起来的一副木架"（晾衣架/锯木架）。
   这跟枯树长成根团、火塘长成石堆是同一条：**姿态必须单独写死，而且要带否定句**。

2. **绳是模型自带的，位置在包围盒 73.6% / 63.7% 处**，只有 0.47 m 长、下端悬在 1.2 m，
   读成"梁上挂了团绳"。引擎侧只能拿这个硬编码的比例去补，模型一换就全错。

这一版的做法：
- 姿态前置并且带三条否定：exactly vertical / exactly parallel / 不内倾不汇聚，
  间距上下相等。
- **模型里明确不要绳**（there is no rope ...），绳改由引擎挂在**横梁正中**，
  位置是枢轴局部的 (0, 0)，不再依赖包围盒比例。
- 加两道 45° 斜撑。这是"人造结构"最强的一条线索，也能压住柱子看起来像两根木棍。
- 两根柱脚各一块扁平石础，解决"柱子悬空"的读法，也顺手把落地写死。

整体比例（第一句）: 3.20 高 / 2.60 跨 —— 高度略大于跨度，避免读成门框。
"""
import json, pathlib

EP = {"method": "POST", "path": "/lux3d/v1/generate/text-to-3d/task/create"}
TAIL = ("Hand painted stylised game asset, broad flat colour fields, clean hard "
        "silhouette, low detail density.")

PROMPT = (
    "A wooden gallows frame standing on bare earth, environment prop. Its overall "
    "proportion is 3.20 metres tall and 2.60 metres wide across the two posts, so it is "
    "slightly taller than it is wide, a tall narrow gateway shape, not a wide arch and not "
    "a low bench. "
    "The frame is one continuous joined wooden structure: every joint is a tight "
    "mortise-and-tenon with no gap, no daylight and no rope lashings at the joints. "
    "POSE, this is the important part and it must be exact: there are two upright posts "
    "and both of them are exactly vertical, exactly parallel to each other, and exactly "
    "90 degrees to the ground. The two posts do not lean in toward each other, they do "
    "not converge at the top, they do not splay outward at the bottom, they do not form "
    "an A shape, a triangle or a sawhorse. The clear gap between the two posts is 2.38 "
    "metres at the ground and it is still 2.38 metres at the top, the gap is identical at "
    "every height. Each post is 3.20 metres tall above the ground and 0.22 metres square "
    "in section. "
    "One horizontal crossbeam lies flat across the top of both posts, 3.04 metres long and "
    "0.26 metres square in section, so it overhangs 0.22 metres past each post, its top "
    "face 3.33 metres above the ground and perfectly level. "
    "Two diagonal knee braces brace the frame, one on each post: each brace is 1.05 metres "
    "long and 0.14 metres square, and it runs at 45 degrees from the inner face of its "
    "post up to the underside of the crossbeam, one end bolted to the post 1.05 metres "
    "below the beam and the other end meeting the beam 0.75 metres in from the post. Both "
    "braces sit in the same vertical plane as the frame, they are not angled out to the "
    "sides. "
    "Each post stands on its own flat fieldstone footing, 0.58 metres across and 0.16 "
    "metres high, a single flat slab sunk level into the dirt with its top face just above "
    "the soil, and the squared bottom end of the post rests on that slab. There is no "
    "platform, no stairs, no pit and no crossbar lower down. "
    "There is no rope, no chain, no noose, no body and no cage anywhere on this object, it "
    "is only the bare timber frame and its two stone footings. "
    "Weathered dark oak 5A4632 on lit faces and 3A2E22 on shadow faces, cut end grain pale "
    "C8B48E on the post tops and beam ends, iron bolt heads 4A4A4A, fieldstone footing "
    "9A968D with 6E6A62 shadow. " + TAIL + " From a 58 degree top-down game camera the two "
    "posts stay visibly parallel and vertical with the beam square across the top, and it "
    "reads as a gibbet frame, not as a bench or a sawhorse."
)

B6 = {"1": {
    "endpoint": EP,
    "parameters": {"body": {
        "version": "G1",
        "style": "hand_painted",
        "faceCount": 20000,
        "outputFormat": ["glb"],
        "prompt": PROMPT,
    }},
}}

out = pathlib.Path('models/env-run/batch6_items.json')
out.write_text(json.dumps(B6, ensure_ascii=False, indent=1), encoding='utf-8')
print('1', len(PROMPT), 'chars ->', out)

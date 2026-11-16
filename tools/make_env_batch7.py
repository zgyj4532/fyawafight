"""第七批：重做枯树（1 个物件）。

第一版（任务 6394619）归一化后 1.19 m 宽 × 1.19 高 —— 是一团**根球**，
在 58° 俯视下读成"地上一坨树根"，所以当时决定"保留现状"、没有进 body。
但那是错的判断：枯树是唯一能给路边"死"这层意思的竖直件，
而它失败的原因和枯树本身没关系，和火塘长成石堆、绞刑架长成 A 字架是同一条：

**整体比例没写，模型就往自己熟悉的团块上靠。**

这一版的做法（和第六批同一套）：
- 整体比例**放在第一句**：4.40 m 高 / 冠幅 3.00 m，高宽比 1.5:1，往上长不往横里长。
- 三条否定：不是根球、不是树桩、不是倒木；地面以上**没有裸露的根**。
- **冠形要为俯视设计**：58° 俯视下一棵枯树只有枝的走向，没有树冠剪影。
  所以要求 4 根主枝（每根 ≥ 1.20 m）、分叉夹角 35–55°、枝间留空隙、
  枝粗 7–12 cm —— 这样从上往下看是"放射状的骨架"，不是一坨毛。
- 明确 no leaves / no foliage / no moss，颜色给灰褐两档，绿一点都不要。
"""
import json, pathlib

EP = {"method": "POST", "path": "/lux3d/v1/generate/text-to-3d/task/create"}
TAIL = ("Hand painted stylised game asset, broad flat colour fields, clean hard "
        "silhouette, low detail density.")

PROMPT = (
    "A single bare dead tree standing upright on flat ground, environment prop. Its "
    "overall proportion is 4.40 metres tall and 3.00 metres across the widest part of its "
    "branches, so it is clearly taller than it is wide, a tall narrow skeleton reaching "
    "upward, not a low round mass. "
    "There is one single straight trunk. The trunk is 0.30 metres thick at the ground, it "
    "tapers smoothly to 0.14 metres where the first branches leave it at 2.10 metres above "
    "the ground, and it does not flare outward at the bottom. The base of the tree meets "
    "the ground as a single clean trunk cross-section, and there are no roots visible above "
    "ground at all: no root ball, no root flare, no exposed root legs, no mound of earth, "
    "no boulders. "
    "The tree is completely dead and completely bare: there are no leaves, no needles, no "
    "foliage, no moss, no twigs finer than 3 centimetres, nothing hangs from the branches. "
    "There are four primary branches. Each primary branch leaves the trunk at 2.10 to 3.10 "
    "metres above the ground, is at least 1.20 metres long and is 0.11 metres thick where "
    "it leaves the trunk. Each primary branch rises outward at 35 to 55 degrees from "
    "vertical, so the branches spread up and out rather than folding down. Each primary "
    "branch forks once into two secondary branches of 0.55 metres, and each secondary "
    "branch ends in a short bare stub. The branches keep wide empty gaps between them, the "
    "silhouette is open and you can see straight through the crown, it is not a dense "
    "tangle, not a bush, not a bramble. "
    "This object is only the standing dead tree with its branches: it is not a stump, not a "
    "fallen log, not a driftwood pile, not a rock formation, not an anthill, and the "
    "ground around it is flat and empty. "
    "Weathered grey-brown dead wood 6E6252 on lit faces and 4A4038 on shadow faces, cut end "
    "grain 8C7C66 on the broken branch stubs, absolutely no green anywhere on the object. "
    + TAIL + " From a 58 degree top-down game camera the object reads as an open radial "
    "skeleton of bare branches around one straight trunk, standing upright on flat ground."
)

B7 = {"1": {
    "endpoint": EP,
    "parameters": {"body": {
        "version": "G1",
        "style": "hand_painted",
        "faceCount": 20000,
        "outputFormat": ["glb"],
        "prompt": PROMPT,
    }},
}}

out = pathlib.Path('models/env-run/batch7_items.json')
out.write_text(json.dumps(B7, ensure_ascii=False, indent=1), encoding='utf-8')
print('1', len(PROMPT), 'chars ->', out)

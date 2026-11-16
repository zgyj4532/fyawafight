"""第二批体量层 6 个物件：废墟拱门 / 断塔 / 立石群 / 枯树 / 石井 / 巨兽骨骸。

提示词沿用前两轮实测出来的规律，逐条对应：

1. **连通性在第一句说死**。一体的写 "one continuous solid body, the outline is a single
   unbroken shape"；分开的写 "genuinely separate objects, open empty air between them"。
2. **尺寸给米**，不给 customSize（G1 上实测无效，模型固定约 1.2 m，尺寸靠引擎缩放）。
3. **落地要写明**，否则会有单件悬空 —— 上一轮遗迹柱短柱离地 0.96 m 就是这么来的。
4. **细节下限**：1600×900、相机高 16 m、俯角 58°，约 57.6 px/m，比赛 4 px ≈ 6 cm。
   所以枝干、榫头这类细节一律给 ≥10 cm 的尺寸，否则进游戏只剩一闪。
5. 结尾固定一句 "From a 58 degree top-down game camera it reads as ..."，
   直接告诉模型判读视角。

用法：python tools/make_env_batch2.py  -> models/env-run/batch2_items.json
"""
import json, pathlib

EP = {"method": "POST", "path": "/lux3d/v1/generate/text-to-3d/task/create"}
TAIL = ("Hand painted stylised game asset, broad flat colour fields, clean hard "
        "silhouette, low detail density.")


def item(prompt, face=20000):
    return {
        "endpoint": EP,
        "parameters": {"body": {
            "version": "G1",
            "style": "hand_painted",
            "faceCount": face,
            "outputFormat": ["glb"],
            "prompt": prompt,
        }},
    }


B2 = {}

# 1. 废墟拱门 —— 可以走过去的门，最像地标的体量物
B2["1"] = item(
    "A ruined stone gateway standing alone on bare earth, environment prop. "
    "It is one continuous solid body: two square piers with one semicircular arch "
    "ring spanning between them, the outline is a single unbroken shape from every "
    "side, no gaps in the mass. The opening between the piers is 3.2 metres wide and "
    "the crown of the arch is 4.2 metres above the ground, the piers are 0.9 metres "
    "thick and 1.0 metre deep, the whole thing is 5.0 metres wide. Both piers stand "
    "firmly on the ground, the bottom course is buried in the dirt. One loose ashlar "
    "block lies on the ground beside the right pier as a genuinely separate piece "
    "with open air around it. Pale ruin stone A9AEB3 on lit faces, cooler 7E858C on "
    "shadow faces, moss 5B6B4A in the joints and wet dirt 6B5A45 around the bases. "
    + TAIL + " From a 58 degree top-down game camera it reads as a stone gate you "
    "could walk through."
)

# 2. 断塔 —— 地图上的垂直地标
B2["2"] = item(
    "A shattered stone watchtower standing alone on bare earth, environment prop. "
    "It is one continuous solid body, the outline is a single unbroken shape: a square "
    "tapered tower whose top has broken away, the broken rim jagged and higher on one "
    "side where the wall still stands tallest. The base is 3.2 metres square, the top "
    "is 2.6 metres square, the tallest surviving corner is 7 metres above the ground. "
    "The wall is 0.7 metres thick, the top is open so the dark inside of the tower is "
    "visible from above, floor of the shaft in deep shadow 2E3338. A doorway 1.2 metres "
    "wide and 2 metres tall is cut through the wall on one side. Pale ruin stone A9AEB3 "
    "on lit faces, cooler 7E858C on shadow faces, moss 5B6B4A in the joints, dark dirt "
    "6B5A45 at the base. " + TAIL + " From a 58 degree top-down game camera it reads as "
    "a broken tower stump with a dark open top."
)

# 3. 立石群 —— 三块立石，明确分开
B2["3"] = item(
    "Three separate standing stones on bare earth, environment prop. The three stones "
    "are genuinely separate objects: each rises on its own footprint with open empty "
    "air between them, they never touch and never merge, and the outline from any "
    "direction shows three distinct slabs with clear gaps. The tallest is 3.4 metres "
    "high, 1.1 metres wide and 0.45 metres thick; the second 2.4 metres; the third 1.7 "
    "metres and leaning about 12 degrees. They stand within a 3 metre circle, roughly "
    "in a line. All three are bedded into the ground, the bottom edge buried, nothing "
    "floats. Weathered grey-blue granite 8B9196 on lit faces, cooler 6A7076 on shadow "
    "faces, lichen 7C8A6B in patches. " + TAIL + " From a 58 degree top-down game camera "
    "it reads as three upright slabs casting three separate shadows."
)

# 4. 枯树 —— 全部分枝从主干长出，不允许飘枝
B2["4"] = item(
    "A single dead bare tree standing alone on bare earth, environment prop. It is one "
    "continuous solid body: every branch grows out of the trunk and out of another "
    "branch, the outline is a single unbroken shape, no branch floats free. The trunk "
    "is 5.4 metres tall and 0.5 metres thick at the base, splitting at 2.2 metres into "
    "four main limbs that twist upward and outward, each limb at least 0.18 metres "
    "thick, ending in blunt snapped tips. No leaves anywhere, no small twigs thinner "
    "than 0.12 metres. The trunk stands firmly in the ground, the roots flare into the "
    "dirt. Bark dead grey-brown 4A3B2E on lit sides, darker 2E2520 on shadow sides, "
    "bleached 6E5F4C on the weathered upper limbs. " + TAIL + " From a 58 degree "
    "top-down game camera it reads as a bare forked trunk with four thick limbs."
)

# 5. 石井 —— 村口尺度的小地标
B2["5"] = item(
    "A stone well with a wooden winch frame standing on bare earth, environment prop. "
    "It is one continuous solid body: a round stone rim, two upright timber posts rising "
    "from the rim, one horizontal timber crossbar between them, all joined, the outline "
    "is a single unbroken shape. The rim is 1.6 metres across and 0.9 metres tall, built "
    "from three courses of rough fieldstone; the two posts are 0.16 metres square and "
    "rise 1.5 metres above the rim, the crossbar spans between their tops and carries a "
    "short rope with a small bucket hanging 0.5 metres down. The mouth of the well is "
    "open and its inside is dark, 2A2420. The rim sits flat on the ground, the bottom "
    "course buried. Fieldstone 9A968D on lit faces, cooler 76736C on shadow faces, moss "
    "5B6B4A between the stones, timber 5A4632. " + TAIL + " From a 58 degree top-down "
    "game camera it reads as a dark round hole with a small timber frame over it."
)

# 6. 巨兽骨骸 —— 每根肋骨都是独立件
B2["6"] = item(
    "The bleached skeleton of a large beast half buried in bare earth, environment prop. "
    "The bones are genuinely separate pieces: a spine lying along the ground with seven "
    "curved ribs rising out of it, each rib its own separate bone with open empty air "
    "between neighbouring ribs, the ribs never touch each other. The spine is 3.6 metres "
    "long and 0.3 metres thick, the ribs arch 1.3 metres above the ground and are 0.14 "
    "metres thick, they lean slightly backward and the last two have collapsed outward. "
    "A skull with a long snout and two curved horns lies 0.6 metres ahead of the first "
    "rib, its own separate piece. Every bone rests in the ground, the lower halves buried, "
    "nothing floats. Bleached bone D8D2C0 on lit faces, cooler AEAA9B on shadow faces, "
    "dirt 6B5A45 packed between the ribs. " + TAIL + " From a 58 degree top-down game "
    "camera it reads as a row of white curved ribs along a spine in the dirt."
)

out = pathlib.Path('models/env-run/batch2_items.json')
out.write_text(json.dumps(B2, ensure_ascii=False, indent=1), encoding='utf-8')
for k, v in B2.items():
    print(k, len(v['parameters']['body']['prompt']), 'chars')
print('->', out)

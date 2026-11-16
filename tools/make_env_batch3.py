"""第三批：巨兽骨骸 + 绞刑架。

两个都是**叙事道具**——不只是"场景填充物"，而是能让玩家读出"这里发生过什么"的物件。
骨骸回答"为什么路荒了"，绞刑架回答"谁在这里执法"。

提示词沿用前两轮实测规律，并补上第二批枯树暴露出来的第 6 条：

1. **连通性在第一句说死**：一体的写 "one continuous solid body, the outline is a single
   unbroken shape"；分开的写 "genuinely separate objects, open empty air between them"。
2. **尺寸给米**，不给 customSize（G1 上实测无效，模型固定约 1.2 m，尺寸靠引擎缩放）。
3. **落地要写明**，否则会有单件悬空。
4. **细节下限**：约 57.6 px/m，细节要 ≥4 px ≈ 6 cm，一律给 ≥10 cm。
5. 结尾固定 "From a 58 degree top-down game camera it reads as ..."。
6. **朝向/姿态必须单独写死**（枯树的教训：连通性只管拓扑，管不住姿态）。
   要竖的就把"向上"写成唯一方向，并给出"高 > 宽"的比例约束；
   要悬空挂着的就明说 "hangs free in the air, does not reach the ground"，
   否则模型会把它放到地上，或者干脆不生成。

用法：python tools/make_env_batch3.py  -> models/env-run/batch3_items.json
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


B3 = {}

# 1. 巨兽骨骸 —— 肋骨必须竖着拱起，这是枯树失败后补的姿态约束
B3["1"] = item(
    "The bleached skeleton of a large beast half buried in bare earth, environment prop. "
    "The bones are genuinely separate pieces: a spine lying along the ground with eight "
    "curved ribs rising out of its top, each rib its own separate bone with open empty "
    "air between neighbouring ribs, no rib touches the next one, and no rib is joined to "
    "its neighbour by webbing or membrane. POSE, this is the important part: each rib "
    "leaves the spine and rises almost straight up, tilting back only 12 degrees, so the "
    "ribs stand nearly vertical and the skeleton is clearly taller than it is wide - the "
    "rib cage is 1.45 metres tall and only 0.85 metres wide across, while the whole spine "
    "runs 3.6 metres along the ground. The ribs do not lie flat, they do not splay "
    "outward along the ground, they stand up. Each rib is 0.15 metres thick and spreads "
    "0.35 metres apart from the next. The top two thirds of every rib is above the "
    "ground, the spine is half sunk in the dirt with dirt packed between the bones. "
    "A skull with a long blunt snout and two thick curved horns lies on the ground 0.5 "
    "metres in front of the first rib, as its own separate piece, resting on the dirt. "
    "Bleached bone D8D2C0 on lit faces, cooler AEAA9B on shadow faces, old dirt 6B5A45 "
    "in the gaps. " + TAIL + " From a 58 degree top-down game camera it reads as a row "
    "of eight pale upright ribs standing along a sunken spine in the dirt."
)

# 2. 绞刑架 —— 木头门架 + 悬垂的绳套，路上最直白的警示
B3["2"] = item(
    "A weathered timber gallows standing alone on bare earth, environment prop. "
    "The frame is one continuous solid body: two square upright posts, one horizontal "
    "crossbeam across their tops joined into them with visible mortise joints, the "
    "outline is a single unbroken shape with no gaps in the mass. Each post is 0.22 "
    "metres square and rises 3.1 metres above the ground, the two posts stand 2.4 metres "
    "apart, the crossbeam is 0.24 metres square and 3.4 metres long so it overhangs the "
    "right post by 0.6 metres. From that overhanging end a thick hemp rope hangs straight "
    "down for 1.5 metres and ends in an open loop noose 0.4 metres across. The rope is a "
    "separate piece and hangs free in the air, it does not touch the ground and nothing "
    "is suspended inside the noose. Each post stands on a flat rough fieldstone base "
    "0.7 metres across, the stones buried in the dirt, the posts stand firmly, nothing "
    "floats. Weathered dark timber 4A3B2E on lit faces, near black 2B2118 on shadow "
    "faces, grey hemp C0B096, fieldstone 9A968D. " + TAIL + " From a 58 degree top-down "
    "game camera it reads as a timber doorway frame with a rope hanging on one side."
)

out = pathlib.Path('models/env-run/batch3_items.json')
out.write_text(json.dumps(B3, ensure_ascii=False, indent=1), encoding='utf-8')
for k, v in B3.items():
    print(k, len(v['parameters']['body']['prompt']), 'chars')
print('->', out)

"""第四批：人的痕迹（4 个叙事物件）。

前三批全是体量和建筑——塔、拱门、立石、骨骸、绞刑架。
它们回答的是"这里是什么地方"，回答不了"这里的人怎么了"。
这一批反过来：全部是**人用过的东西**，而且全部是**被丢下的**。

1. overturned_handcart  翻倒的行李车  —— 走得太急，车翻在路边
2. broken_shield_sword  破盾与断剑    —— 抵抗过，没成功
3. cloak_cross          挂布的十字架  —— 有人埋在这里
4. campfire_remains     熄灭的火塘    —— 最后一夜

提示词规律（三轮实测，逐条对应）：

1. **连通性第一句说死**。"one continuous solid body" / "genuinely separate objects,
   open empty air between them"。
2. **尺寸给米**，不给 customSize（G1 上无效）。
3. **落地写明**："stands firmly on the ground / lies flat on the ground / bottom buried"。
4. **细节 ≥ 6 cm**（57.6 px/m 下 4 px 的下限），一律给 ≥ 10 cm。
5. 结尾固定 "From a 58 degree top-down game camera it reads as ..."。
6. **姿态单独写死**：要在空中的就写 "hangs free in the air, does not touch the ground"；
   要倒的就写倒的角度和哪一侧。枯树就是只写 outward 不写角度，长成了一个根团。

用法：python tools/make_env_batch4.py  -> models/env-run/batch4_items.json
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


B4 = {}

# 1. 翻倒的行李车 —— 幕二：人走得急
B4["1"] = item(
    "An overturned wooden handcart abandoned on bare earth, environment prop. "
    "The cart bed and its two side rails form one continuous solid body of nailed "
    "planks, the outline of the bed is a single unbroken shape. The two spoked wheels "
    "are genuinely separate pieces, open empty air between each wheel and the bed, each "
    "wheel bolted to the outside of a side rail. POSE, this is the important part: the "
    "cart is tipped over onto its right side, so the flat bed plane is tilted 55 degrees "
    "away from horizontal and one wheel is up in the air above the bed while the other "
    "wheel lies flat on the ground carrying the weight. Both wooden handles point away "
    "from the camera side, one of them snapped off short. The bed is 2.2 metres long and "
    "1.3 metres wide, each wheel is 0.85 metres across with eight flat spokes 0.07 metres "
    "thick, the planks are 0.09 metres thick. A heap of three torn sackcloth bundles "
    "spills out of the upturned bed and lies on the dirt beside it, each sack its own "
    "separate lump 0.45 metres across. Everything rests on the ground, the fallen wheel "
    "and the spilled sacks are buried a little into the dirt, nothing floats. Weathered "
    "cart wood 6B543C on lit faces, 3E2F22 on shadow faces, iron wheel rim 4A4A4A, "
    "sackcloth B9A783. " + TAIL + " From a 58 degree top-down game camera it reads as a "
    "wooden cart lying on its side with one wheel sticking up in the air."
)

# 2. 破盾与断剑 —— 幕三：抵抗过
B4["2"] = item(
    "A battered round wooden shield leaning against a low fieldstone block, with a "
    "broken sword lying on the ground in front of it, environment prop. "
    "These are genuinely separate objects with open empty air between them: one rough "
    "rectangular fieldstone block, one round wooden shield, one broken iron sword. "
    "POSE: the fieldstone block stands on the ground, 0.95 metres long, 0.55 metres tall "
    "and 0.45 metres deep, its top face flat. The round shield leans against the front "
    "face of that block, tilted 20 degrees away from vertical, its bottom rim resting on "
    "the ground and its top rim touching the stone, the shield is 1.05 metres across and "
    "0.13 metres thick, made of six radial planks with an iron boss 0.22 metres across at "
    "the centre and a split iron rim. The shield face carries three long axe cuts. "
    "The sword lies flat on the ground in front of the shield, not standing, not leaning, "
    "lying horizontally with its point towards the camera: the blade is snapped in two, "
    "a 0.55 metre lower half with the crossguard and grip, and a 0.30 metre broken tip "
    "lying 0.25 metres further on, both halves flat in the dirt. Everything rests on the "
    "ground, the block and the sword halves are buried a little into the dirt, nothing "
    "floats. Shield wood 7A5A3C with 4C3A26 shadow, iron 55555A, fieldstone 9A968D, "
    "chipped pale wood C8B48E on the cut edges. " + TAIL + " From a 58 degree top-down "
    "game camera it reads as a round shield propped against a stone with a snapped sword "
    "lying at its foot."
)

# 3. 挂布的十字架 —— 幕三：有人埋在这里
B4["3"] = item(
    "A rough wooden grave cross with a tattered dark cloak draped over its crossbar, "
    "planted in bare earth, environment prop. "
    "The cross is one continuous solid body: a vertical post and a horizontal crossbar "
    "joined into it, a single unbroken shape with no gap at the joint. The cloak is a "
    "genuinely separate piece of cloth, open empty air between the cloth and the post "
    "below the crossbar. POSE, this is the important part: the post stands upright and "
    "vertical, 2.00 metres tall above the ground and 0.13 metres square, its bottom end "
    "buried in the dirt. The crossbar is 1.15 metres wide, 0.11 metres square, its centre "
    "1.62 metres above the ground. The cloak hangs from that crossbar and falls straight "
    "down like a curtain, its top edge folded over the bar, its hem ending 0.40 metres "
    "above the ground: the cloth hangs free in the air, it does not reach the ground, it "
    "does not lie on the ground, it is not spread out flat. The cloak is 1.05 metres wide "
    "and 1.15 metres long with a torn ragged hem and two long rips. Nothing else is "
    "suspended. Weathered post wood 5A4632, cloak dark wool 3A3226 on lit faces and "
    "241F18 on shadow faces, patches of faded ochre A8875A. " + TAIL + " From a 58 degree "
    "top-down game camera it reads as a wooden cross with a dark cloth hanging down from "
    "its arms."
)

# 4. 熄灭的火塘 —— 幕二：最后一夜
B4["4"] = item(
    "A dead campfire on bare earth, environment prop. "
    "These are genuinely separate objects with open empty air between them: a ring of "
    "nine fieldstones, a low bed of cold ash, and three charred logs. "
    "POSE: the nine fieldstones lie in a single flat ring on the ground, each stone its "
    "own separate lump 0.28 metres across and 0.16 metres tall, spaced 0.10 metres apart, "
    "the ring is 1.30 metres across outside to outside, every stone sits flat on the "
    "ground with its base buried in the dirt. The ash bed fills the inside of the ring, "
    "0.95 metres across and only 0.07 metres high, a flat cold grey disc of powder with "
    "no flame and no glow. The three charred logs lie flat inside the ash, each log 0.75 "
    "metres long and 0.14 metres thick, crossing each other at low angles like a star, "
    "burnt through and broken, their ends resting in the ash: the logs do not stand up, "
    "they lie flat. Nothing floats and nothing stands upright except the ring stones' own "
    "short height. Fieldstone 9A968D with 6E6A62 shadow, cold ash 8A8880, charred wood "
    "2E2A25 with grey 6E6A62 on the burnt edges. " + TAIL + " From a 58 degree top-down "
    "game camera it reads as a ring of nine stones around a flat grey patch of ash with "
    "three black logs lying across it."
)

out = pathlib.Path('models/env-run/batch4_items.json')
out.write_text(json.dumps(B4, ensure_ascii=False, indent=1), encoding='utf-8')
for k, v in B4.items():
    print(k, len(v['parameters']['body']['prompt']), 'chars')
print('->', out)

"""第五批：重做熄灭的火塘（1 个物件）。

第四批的 campfire_remains 拿到的是一堆垒起来的石头（1.2 × 1.17 × 1.19 m 的球状石堆），
和 props.js 里已有的 cairn（路旁石堆）撞车，读不出「火塘」。

失败原因：提示词写了「九块石头围成一圈、石头高 0.16 m」，但没有把**整体高度**写死。
模型对「围成一圈」的默认理解是**沿圈堆高**，于是长成了石堆。这和枯树的教训是同一条：
**写单件的尺寸不够，必须写整体的比例**，而且要给出"不许堆"的否定句。

这一版补三处：
1. 整体比例放在最前面说死：1.30 宽 / 0.22 高，「几乎全平」。
2. 明确否定：not a pile, not a mound, not stacked, no stone rests on another stone。
3. 结尾的可读性描述也说成"一个平铺的环"，不是"一堆"。
"""
import json, pathlib

EP = {"method": "POST", "path": "/lux3d/v1/generate/text-to-3d/task/create"}
TAIL = ("Hand painted stylised game asset, broad flat colour fields, clean hard "
        "silhouette, low detail density.")

PROMPT = (
    "A dead campfire on bare earth, environment prop, and the important thing about it "
    "is that it is almost completely flat: the whole object is 1.30 metres across but "
    "only 0.22 metres tall, it is a flat disc lying on the ground, not a pile and not a "
    "mound. "
    "It is made of genuinely separate objects with open empty air between them: nine "
    "fieldstones, a low bed of cold ash, and three charred logs. "
    "POSE: the nine fieldstones lie in one single flat ring on the ground, each stone its "
    "own separate lump 0.26 metres across and 0.15 metres tall, arranged in a circle that "
    "is 1.30 metres across outside to outside, all nine stones at the same height. No "
    "stone rests on top of another stone, the stones are not stacked, they are not heaped "
    "up into a cairn, each one sits on the ground by itself and its base is buried a "
    "little in the dirt. The centre of the ring is open and flat, filled with a cold grey "
    "ash bed 0.95 metres across and only 0.05 metres high, a flat powder-grey disc with "
    "no flame, no glow, no smoke, no embers. The three charred logs lie flat on that ash, "
    "each log 0.70 metres long and 0.13 metres thick, crossing each other at low angles "
    "like a star, burnt through and broken, lying horizontally with their ends in the "
    "ash, the logs do not stand up and do not lean on the stones. "
    "Nothing rises above 0.22 metres, nothing is stacked, the silhouette is a flat wide "
    "ring, not a tall heap. Fieldstone 9A968D with 6E6A62 shadow, cold ash 8A8880, "
    "charred wood 2E2A25 with grey 6E6A62 on the burnt edges. " + TAIL + " From a 58 "
    "degree top-down game camera it reads as a wide flat ring of nine small stones around "
    "a grey patch of ash with three black logs lying across it, much wider than it is tall."
)

B5 = {"1": {
    "endpoint": EP,
    "parameters": {"body": {
        "version": "G1",
        "style": "hand_painted",
        "faceCount": 20000,
        "outputFormat": ["glb"],
        "prompt": PROMPT,
    }},
}}

out = pathlib.Path('models/env-run/batch5_items.json')
out.write_text(json.dumps(B5, ensure_ascii=False, indent=1), encoding='utf-8')
print('1', len(PROMPT), 'chars ->', out)

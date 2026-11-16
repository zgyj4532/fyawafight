"""Grass tuft prototype.

Purpose: decide whether the flat ground texture is the reason the meadow reads
as dirty, or whether the missing geometry is. Builds one procedural grass mesh
(many tufts merged into a single object, the same batching an InstancedMesh does
at runtime), renders the game camera with and without it.

Run:
  blender -b --python tools/blender_grass_proto.py -- --mode both
"""

import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN = os.path.join(PROJECT, "models", "env-run")
TEX = os.path.join(PROJECT, "models", "env", "textures")

# Colours sampled from the locked palette.
def srgb_to_linear(rgb):
    c = np.array(rgb, dtype=np.float32) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


# Vertex colours are consumed as linear values, so convert from the sRGB palette.
DARK = srgb_to_linear([0x2A, 0x4C, 0x1E])
MID = srgb_to_linear([0x54, 0x8B, 0x2D])
LIGHT = srgb_to_linear([0x7C, 0xB2, 0x3E])
TIP = srgb_to_linear([0x9C, 0xC8, 0x58])

# Tuft budget. 1 tuft covers roughly one square metre of visible ground.
TUFT_COUNT = 6000
BLADES_PER_TUFT = 18
SEGMENTS = 4
FIELD = 30.0           # side length of the grassed area, metres
TUFT_RADIUS = 0.38

ROAD_HALF = 2.6        # dirt road half width
ROAD_SLOPE = -0.34


def on_road(x, y):
    return abs(y - (ROAD_SLOPE * x + 1.5)) < ROAD_HALF


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def build_grass():
    """One mesh holding every tuft, matching how an InstancedMesh batches."""
    rng = np.random.default_rng(20261111)

    verts = []
    faces = []
    colors = []
    cursor = 0

    # Cluster centres, rejection sampled off the road.
    wanted = TUFT_COUNT
    centres = []
    guard = 0
    while len(centres) < wanted and guard < wanted * 40:
        guard += 1
        cx = rng.uniform(-FIELD / 2, FIELD / 2)
        cy = rng.uniform(-FIELD / 2, FIELD / 2)
        if on_road(cx, cy):
            continue
        # Density falloff towards the arena edge so the field is not a carpet.
        centres.append((cx, cy))
    centres = np.array(centres, dtype=np.float32)
    wanted = len(centres)

    # Per tuft: blade count, size scale, brightness, hue lean.
    counts = rng.integers(max(4, BLADES_PER_TUFT - 5), BLADES_PER_TUFT + 5, wanted)
    scales = rng.uniform(0.78, 1.26, wanted).astype(np.float32)
    bright = rng.normal(1.0, 0.10, wanted).astype(np.float32)
    warmth = rng.uniform(-0.10, 0.14, wanted).astype(np.float32)

    seg_t = np.linspace(0.0, 1.0, SEGMENTS + 1, dtype=np.float32)

    for ti in range(wanted):
        cx, cy = centres[ti]
        n = int(counts[ti])
        scale = float(scales[ti])
        b = float(bright[ti])
        warm = float(warmth[ti])
        base_c = DARK * b
        mid_c = MID * b
        light_c = LIGHT * b
        tip_c = TIP * (b * (1.0 + warm))

        for _ in range(n):
            az = rng.uniform(0, math.tau)
            # Blades lean away from the tuft centre plus a shared wind bias.
            lean = rng.uniform(0.06, 0.40)
            wind = 0.18 * math.cos(az - 0.7)
            length = float(rng.uniform(0.14, 0.30)) * scale
            w0 = float(rng.uniform(0.030, 0.055)) * scale
            dist = float(rng.uniform(0.0, TUFT_RADIUS)) * scale

            # Root position inside the tuft.
            rx = cx + math.cos(az) * dist
            ry = cy + math.sin(az) * dist
            side = np.array([-math.sin(az), math.cos(az), 0.0], dtype=np.float32)
            outward = np.array([math.cos(az), math.sin(az), 0.0], dtype=np.float32)

            row = len(verts)
            for s in seg_t:
                bend = (lean + wind) * s + 0.85 * s * s * s
                reach = length * s
                height = reach * math.cos(bend)
                spread = reach * math.sin(bend)
                w = w0 * max(0.04, (1.0 - s ** 1.15))
                cxw = rx + outward[0] * spread
                cyw = ry + outward[1] * spread
                verts.append((cxw + side[0] * w * 0.5, cyw + side[1] * w * 0.5, height))
                verts.append((cxw - side[0] * w * 0.5, cyw - side[1] * w * 0.5, height))
                # Vertical gradient: dark root, mid body, bright tip.
                if s < 0.34:
                    col = base_c + (mid_c - base_c) * (s / 0.34)
                elif s < 0.72:
                    col = mid_c + (light_c - mid_c) * ((s - 0.34) / 0.38)
                else:
                    col = light_c + (tip_c - light_c) * ((s - 0.72) / 0.28)
                colors.append((float(col[0]), float(col[1]), float(col[2]), 1.0))
                colors.append((float(col[0]) * 0.92, float(col[1]) * 0.92,
                               float(col[2]) * 0.92, 1.0))
            for s in range(SEGMENTS):
                a = row + s * 2
                faces.append((a, a + 1, a + 3, a + 2))
            cursor = len(verts)

    mesh = bpy.data.meshes.new("GrassMesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()

    color_layer = mesh.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="POINT")
    flat = np.array(colors, dtype=np.float32).reshape(-1, 4)
    color_layer.data.foreach_set("color", flat.ravel())

    obj = bpy.data.objects.new("GrassField", mesh)
    bpy.context.collection.objects.link(obj)

    material = make_grass_material()
    mesh.materials.append(material)

    # Blades are open quads; a hair-thin shell keeps normals valid from both
    # sides so no blade renders black when seen from behind.
    solid = obj.modifiers.new("Shell", "SOLIDIFY")
    solid.thickness = 0.0018
    solid.offset = 0.0
    solid.use_rim = False

    tris = len(faces) * 2
    print(f"[grass] tufts={wanted} blades={wanted * BLADES_PER_TUFT} "
          f"verts={len(verts)} tris={tris}")
    return obj


def make_grass_material():
    material = bpy.data.materials.new("GrassVertexColor")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.78
    if "Specular" in bsdf.inputs:
        bsdf.inputs["Specular"].default_value = 0.22
    if "Sheen" in bsdf.inputs:
        bsdf.inputs["Sheen"].default_value = 0.12
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"

    links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.location = (-260, 0)
    out.location = (60, 0)
    attr.location = (-520, 60)
    return material


def make_ground():
    material = bpy.data.materials.new("GroundGrass")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.92
    if "Specular" in bsdf.inputs:
        bsdf.inputs["Specular"].default_value = 0.1
    tex = nodes.new("ShaderNodeTexImage")
    path = os.path.join(TEX, "env_base_grass.jpg")
    if not os.path.exists(path):
        path = os.path.join(TEX, "env_base_grass.png")
    tex.image = bpy.data.images.load(path, check_existing=True)
    tex.image.colorspace_settings.name = "sRGB"
    mapping = nodes.new("ShaderNodeMapping")
    coord = nodes.new("ShaderNodeTexCoord")
    mapping.inputs["Scale"].default_value = (6.0, 6.0, 1.0)
    links.new(coord.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.location = (-40, 0)
    tex.location = (-460, 0)
    mapping.location = (-680, 0)
    coord.location = (-880, 0)

    bpy.ops.mesh.primitive_plane_add(size=120.0, location=(0, 0, 0))
    ground = bpy.context.object
    ground.data.materials.append(material)
    return ground


def add_lights_and_camera():
    scene = bpy.context.scene

    key_data = bpy.data.lights.new("Key", type="SUN")
    key_data.energy = 2.7
    key_data.color = (1.0, 0.95, 0.86)
    key_data.angle = math.radians(9)
    key = bpy.data.objects.new("Key", key_data)
    key.rotation_euler = (math.radians(46), math.radians(6), math.radians(38))
    scene.collection.objects.link(key)

    fill_data = bpy.data.lights.new("Fill", type="SUN")
    fill_data.energy = 0.68
    fill_data.color = (0.66, 0.76, 0.95)
    fill = bpy.data.objects.new("Fill", fill_data)
    fill.rotation_euler = (math.radians(68), 0.0, math.radians(-136))
    scene.collection.objects.link(fill)

    world = bpy.data.worlds.new("GrassWorld")
    world.use_nodes = True
    bg = next((n for n in world.node_tree.nodes if n.type == "BACKGROUND"), None)
    if bg is not None:
        bg.inputs[0].default_value = (0.55, 0.62, 0.72, 1.0)
        bg.inputs[1].default_value = 0.42
    scene.world = world

    cam_data = bpy.data.cameras.new("GameCam")
    cam_data.lens_unit = "FOV"
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.angle = math.radians(45)
    cam = bpy.data.objects.new("GameCam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def aim(camera, location, target):
    camera.location = location
    direction = Vector(target) - Vector(location)
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def setup_render():
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1080
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.eevee.taa_render_samples = 48
    return scene


def shot(scene, camera, path, pitch=58.0, height=16.0, target=(0.0, 0.0, 0.0)):
    back = height / math.tan(math.radians(pitch))
    loc = (target[0], target[1] - back, height)
    aim(camera, loc, target)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f"[shot] {os.path.basename(path)}")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    os.makedirs(RUN, exist_ok=True)
    clear_scene()
    make_ground()
    grass = build_grass()
    camera = add_lights_and_camera()
    scene = setup_render()

    # 1. Ground only — what the game shows today if the texture were wired in.
    grass.hide_render = True
    shot(scene, camera, os.path.join(RUN, "grass_proto_off.png"))

    # 2. Ground plus geometry.
    grass.hide_render = False
    shot(scene, camera, os.path.join(RUN, "grass_proto_on.png"))

    # 3. Close view of the tufts.
    shot(scene, camera, os.path.join(RUN, "grass_proto_close.png"),
         pitch=32.0, height=4.2, target=(0.0, 0.0, 0.35))

    print("[done]")


if __name__ == "__main__":
    main()

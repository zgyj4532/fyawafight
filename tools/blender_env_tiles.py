"""Build 8 m ground tile GLBs and a 15x15 assembly preview.

Blender 5.x, run headless:
  blender -b --python tools/blender_env_tiles.py -- --mode tiles
  blender -b --python tools/blender_env_tiles.py -- --mode preview
"""
import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector

PROJECT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
ENV = os.path.join(PROJECT, "models", "env")
TEX = os.path.join(ENV, "textures")
RUN = os.path.join(PROJECT, "models", "env-run")

TILE = 8.0
THICK = 0.40
GRID = 15

# name, label, UV repeat per 8 m tile. Integer repeats keep the texture lattice
# aligned across neighbouring tiles, so identical tiles no longer show a grid.
TILES = [
    ("env_ground_grass_a", "地面-草地A", 2),
    ("env_ground_grass_b", "地面-草地B", 2),
    ("env_ground_dirt_path", "地面-裸土", 2),
    ("env_ground_stone_ruin", "地面-石板残迹", 2),
]


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(name, image_path):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    texture = nodes.new("ShaderNodeTexImage")
    image = bpy.data.images.load(image_path, check_existing=True)
    image.pack()
    texture.image = image
    texture.interpolation = "Closest" if False else "Linear"
    shader.inputs["Roughness"].default_value = 1.0
    shader.inputs["Metallic"].default_value = 0.0
    if "Specular IOR Level" in shader.inputs:
        shader.inputs["Specular IOR Level"].default_value = 0.15
    links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return material


def build_tile(name, label, material, repeat=1):
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)

    bm = bmesh.new()
    half = TILE / 2.0
    corners = [(-half, -half), (half, -half), (half, half), (-half, half)]
    top = [bm.verts.new((x, y, 0.0)) for x, y in corners]
    bottom = [bm.verts.new((x, y, -THICK)) for x, y in corners]

    top_face = bm.faces.new(top)
    top_face.smooth = False
    uv_layer = bm.loops.layers.uv.new("UVMap")
    for loop in top_face.loops:
        co = loop.vert.co
        loop[uv_layer].uv = ((co.x + half) / TILE * repeat, (co.y + half) / TILE * repeat)

    for index in range(4):
        a = top[index]
        b = top[(index + 1) % 4]
        c = bottom[(index + 1) % 4]
        d = bottom[index]
        face = bm.faces.new((a, b, c, d))
        face.smooth = False
        for loop in face.loops:
            loop[uv_layer].uv = (0.5, 0.0)

    bottom_face = bm.faces.new(bottom[::-1])
    bottom_face.smooth = False
    for loop in bottom_face.loops:
        loop[uv_layer].uv = (0.5, 0.5)

    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj.data.materials.append(material)
    obj["tile_size"] = TILE
    obj["tile_label"] = label
    return obj


def export(obj, target):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=target,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_image_format="JPEG",
        export_texture_dir="",
        export_cameras=False,
        export_lights=False,
    )
    return os.path.getsize(target)


def mode_tiles():
    clear_scene()
    os.makedirs(ENV, exist_ok=True)
    result = {}
    for name, label, repeat in TILES:
        clear_scene()
        texture_path = os.path.join(TEX, f"{name}.jpg")
        material = make_material(f"{name}_mat", texture_path)
        obj = build_tile(name, label, material, repeat)
        target = os.path.join(ENV, f"{name}.glb")
        size = export(obj, target)
        result[name] = {"glb": target, "bytes": size, "tile": TILE, "thickness": THICK}
        print(f"[tile] {name}\t{size} bytes")
    with open(os.path.join(RUN, "tiles_build.json"), "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=1)


def layout_ground():
    """Deterministic 15x15 ground layout.

    One-tile roads stay off the spawn point so the centre of the arena stays
    readable for combat, matching the design note about keeping the core area clean.
    """
    grid = [["env_ground_grass_a" for _ in range(GRID)] for _ in range(GRID)]
    for index in range(GRID):
        grid[10][index] = "env_ground_dirt_path"
        grid[index][3] = "env_ground_dirt_path"
    # Stone paving stays out of the ground layer: at 8 m per tile it reads as a
    # repeated boulder carpet. Scattered slabs belong to the decor layer instead.
    for row, col in [(6, 6), (6, 7), (7, 6), (7, 7), (5, 8), (8, 5)]:
        grid[row][col] = "env_ground_grass_b"
    for row, col in [(2, 2), (2, 3), (3, 2), (11, 11), (11, 12), (12, 11),
                     (3, 11), (12, 3), (4, 4), (4, 5), (5, 4), (9, 9),
                     (9, 8), (8, 9), (1, 7), (13, 7), (7, 1), (7, 13)]:
        grid[row][col] = "env_ground_grass_b"
    return grid


def add_camera_and_lights():
    scene = bpy.context.scene
    camera_data = bpy.data.cameras.new("GameCam")
    camera_data.lens_unit = "FOV"
    camera_data.sensor_fit = "VERTICAL"
    camera_data.angle = math.radians(45)
    camera = bpy.data.objects.new("GameCam", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    sun_data = bpy.data.lights.new("KeyLight", type="SUN")
    sun_data.energy = 3.0
    sun_data.angle = math.radians(14)
    sun = bpy.data.objects.new("KeyLight", sun_data)
    sun.rotation_euler = (math.radians(36), math.radians(4), math.radians(26))
    scene.collection.objects.link(sun)

    fill_data = bpy.data.lights.new("FillLight", type="SUN")
    fill_data.energy = 0.8
    fill_data.color = (0.72, 0.78, 0.92)
    fill = bpy.data.objects.new("FillLight", fill_data)
    fill.rotation_euler = (math.radians(64), 0.0, math.radians(-142))
    scene.collection.objects.link(fill)

    world = bpy.data.worlds.new("EnvWorld")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs[0].default_value = (0.46, 0.49, 0.55, 1.0)
    background.inputs[1].default_value = 0.6
    scene.world = world
    return camera


def aim(camera, location, target):
    camera.location = location
    direction = Vector(target) - Vector(location)
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def mode_preview():
    clear_scene()
    grid = layout_ground()
    materials = {}
    for name, _, _repeat in TILES:
        materials[name] = make_material(f"{name}_mat", os.path.join(TEX, f"{name}.jpg"))

    meshes = {}
    for name, label, repeat in TILES:
        meshes[name] = build_tile(name, label, materials[name], repeat)

    offset = (GRID - 1) / 2.0
    placed = 0
    for row, line in enumerate(grid):
        for col, name in enumerate(line):
            clone = meshes[name].copy()
            clone.data = meshes[name].data
            bpy.context.collection.objects.link(clone)
            clone.location = ((col - offset) * TILE, (row - offset) * TILE, 0.0)
            placed += 1
    for name, _, _repeat in TILES:
        bpy.data.objects.remove(meshes[name], do_unlink=True)

    camera = add_camera_and_lights()
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.eevee.taa_render_samples = 32
    scene.render.image_settings.file_format = "PNG"

    camera.data.type = "ORTHO"
    camera.data.ortho_scale = GRID * TILE * 1.04
    aim(camera, (0.0, 0.0, 80.0), (0.0, 0.0, 0.0))
    scene.render.filepath = os.path.join(RUN, "render_ground_overview.png")
    bpy.ops.render.render(write_still=True)
    print(f"[preview] overview placed={placed}")

    camera.data.type = "PERSP"
    pitch = math.radians(58)
    height = 16.0
    back = height / math.tan(pitch)
    aim(camera, (-16.0, -8.0 - back, height), (-16.0, -8.0, 0.0))
    scene.render.filepath = os.path.join(RUN, "render_ground_gamecam.png")
    bpy.ops.render.render(write_still=True)
    print("[preview] gamecam")

    aim(camera, (0.0, -back + 0.0, height), (0.0, 0.0, 0.0))
    scene.render.filepath = os.path.join(RUN, "render_ground_junction.png")
    bpy.ops.render.render(write_still=True)
    print("[preview] junction")


def import_glb(path, location):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    imported = [obj for obj in bpy.data.objects if obj not in before]
    roots = [obj for obj in imported if obj.parent is None]
    for obj in roots:
        obj.location = (obj.location.x + location[0],
                        obj.location.y + location[1],
                        obj.location.z + location[2])
    return imported


def mode_characters():
    clear_scene()
    grid = layout_ground()
    materials = {}
    for name, _, _repeat in TILES:
        materials[name] = make_material(f"{name}_mat", os.path.join(TEX, f"{name}.jpg"))
    meshes = {}
    for name, label, repeat in TILES:
        meshes[name] = build_tile(name, label, materials[name], repeat)
    offset = (GRID - 1) / 2.0
    for row, line in enumerate(grid):
        for col, name in enumerate(line):
            clone = meshes[name].copy()
            clone.data = meshes[name].data
            bpy.context.collection.objects.link(clone)
            clone.location = ((col - offset) * TILE, (row - offset) * TILE, 0.0)
    for name, _, _repeat in TILES:
        bpy.data.objects.remove(meshes[name], do_unlink=True)

    rigged = os.path.join(PROJECT, "models", "rigged_v1")
    spawns = [
        ("test_hound", os.path.join(rigged, "hound_rigged_v1.glb"), (0.0, 2.0, 0.0)),
        ("test_slime", os.path.join(rigged, "slime_rigged_v1.glb"), (-2.4, -1.6, 0.0)),
        ("test_ogre", os.path.join(rigged, "ogre_rigged_v1.glb"), (2.6, -2.2, 0.0)),
    ]
    for label, path, location in spawns:
        if not os.path.exists(path):
            print(f"[skip] {label}: {path}")
            continue
        import_glb(path, location)
        print(f"[char] {label}")

    camera = add_camera_and_lights()
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.view_settings.view_transform = "Standard"
    scene.eevee.taa_render_samples = 32
    scene.render.image_settings.file_format = "PNG"
    pitch = math.radians(58)
    height = 16.0
    back = height / math.tan(pitch)
    aim(camera, (0.0, -back, height), (0.0, 0.0, 0.0))
    scene.render.filepath = os.path.join(RUN, "render_env_with_enemies.png")
    bpy.ops.render.render(write_still=True)
    print(f"[characters] {scene.render.filepath}")

    aim(camera, (0.4, -4.6, 4.6), (0.0, 0.6, 0.7))
    scene.render.filepath = os.path.join(RUN, "render_env_closeup.png")
    bpy.ops.render.render(write_still=True)
    print(f"[characters] closeup")


def main():
    argv = sys.argv
    mode = "tiles"
    if "--" in argv:
        extra = argv[argv.index("--") + 1:]
        if "--mode" in extra:
            mode = extra[extra.index("--mode") + 1]
    if mode == "tiles":
        mode_tiles()
    elif mode == "preview":
        mode_preview()
    elif mode == "characters":
        mode_characters()
    else:
        raise SystemExit(f"unknown mode {mode}")


if __name__ == "__main__":
    main()

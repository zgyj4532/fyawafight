"""Measure knight sword, cape, and arm reach so the sweep can stay in front."""
import bpy
from mathutils import Vector
from mathutils.kdtree import KDTree

BLEND = r'models/rigged_v1/boss_knight_rigged_v1.blend'
CAPE = ['Cape.01', 'Cape.02', 'Cape.03', 'Cape.04']


def weighted(mesh, names, threshold=0.5):
    wanted = set()
    for name in names:
        group = mesh.vertex_groups.get(name)
        if group is None:
            continue
        for vertex in mesh.data.vertices:
            for assignment in vertex.groups:
                if assignment.group == group.index and assignment.weight > threshold:
                    wanted.add(vertex.index)
                    break
    return wanted


def main():
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    mesh = next(obj for obj in bpy.context.scene.objects if obj.type == 'MESH' and obj.name.startswith('BossKnight'))
    arm = next(obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE')
    rest = [mesh.matrix_world @ vertex.co for vertex in mesh.data.vertices]
    cape = weighted(mesh, CAPE)
    sword = weighted(mesh, ['Sword'])
    def box(indices):
        pts = [rest[i] for i in indices]
        low = Vector(tuple(min(p[a] for p in pts) for a in range(3)))
        high = Vector(tuple(max(p[a] for p in pts) for a in range(3)))
        return low, high
    for label, indices in (('cape', cape), ('sword', sword)):
        low, high = box(indices)
        print(label, 'n', len(indices), 'min', [round(v, 3) for v in low], 'max', [round(v, 3) for v in high])
    back_sword = [i for i in sword if rest[i].y > 0.05]
    print('sword verts with y>0.05', len(back_sword))
    for name in ('UpperArm.R', 'Forearm.R', 'Hand.R', 'Sword', 'Chest', 'Cape.01'):
        bone = arm.data.bones[name]
        head = arm.matrix_world @ bone.head_local
        tail = arm.matrix_world @ bone.tail_local
        print(name, 'head', [round(v, 3) for v in head], 'tail', [round(v, 3) for v in tail], 'len', round((tail - head).length, 3))
    upper = (arm.matrix_world @ arm.data.bones['UpperArm.R'].tail_local - (arm.matrix_world @ arm.data.bones['UpperArm.R'].head_local)).length
    fore = (arm.matrix_world @ arm.data.bones['Forearm.R'].tail_local - (arm.matrix_world @ arm.data.bones['Forearm.R'].head_local)).length
    print('REACH', round(upper + fore, 3))

    def nearest(points, moving, body):
        tree = KDTree(len(body))
        for slot, index in enumerate(body):
            tree.insert(points[index], slot)
        tree.balance()
        closest = 1e9
        for index in moving:
            _, _, distance = tree.find(points[index])
            closest = min(closest, distance)
        return closest

    arm.animation_data_create()
    arm.animation_data.action = bpy.data.actions['Attack']
    body = [i for i in range(len(rest)) if i not in sword and i not in cape]
    worst = 1e9
    for frame in range(1, 33):
        bpy.context.scene.frame_set(frame)
        deps = bpy.context.evaluated_depsgraph_get()
        evaluated = mesh.evaluated_get(deps)
        current = [evaluated.matrix_world @ vertex.co for vertex in evaluated.data.vertices]
        sword_bone = arm.pose.bones['Sword']
        head = arm.matrix_world @ sword_bone.head
        tail = arm.matrix_world @ sword_bone.tail
        direction = (tail - head).normalized()
        gap = nearest(current, sword, cape)
        worst = min(worst, gap)
        print(
            f'f{frame:02d} tipx={tail.x:6.2f} tipy={tail.y:6.2f} tipz={tail.z:6.2f} '
            f'dir=[{direction.x:6.2f},{direction.y:6.2f},{direction.z:6.2f}] gap={gap:.3f}'
        )
    print('WORST_SWORD_CAPE', round(worst, 3))
    render_sweep(mesh, arm)
    print('PROBE_OK')


def render_sweep(mesh, arm):
    import math
    from pathlib import Path
    out = Path(r'models/rigged_v1/review')
    out.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x = 480
    scene.render.resolution_y = 640
    scene.render.film_transparent = False
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    arm.hide_render = True
    cam_data = bpy.data.cameras.new('SweepCam')
    cam_data.type = 'ORTHO'
    cam = bpy.data.objects.new('SweepCam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    world = scene.world or bpy.data.worlds.new('SweepWorld')
    scene.world = world
    world.color = (0.16, 0.16, 0.17)
    for frame in (1, 8, 12, 16, 24, 32):
        bpy.context.scene.frame_set(frame)
        deps = bpy.context.evaluated_depsgraph_get()
        evaluated = mesh.evaluated_get(deps)
        points = [evaluated.matrix_world @ vertex.co for vertex in evaluated.data.vertices]
        low = Vector(tuple(min(p[a] for p in points) for a in range(3)))
        high = Vector(tuple(max(p[a] for p in points) for a in range(3)))
        center = (low + high) * 0.5
        size = max(high.x - low.x, high.z - low.z, high.y - low.y)
        cam_data.ortho_scale = size * 1.25
        for yaw, label in ((0.0, 'front'), (0.7, 'threeq')):
            cam.location = center + Vector((math.sin(yaw) * size * 3.2, -math.cos(yaw) * size * 3.2, size * 0.05))
            cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
            scene.render.filepath = str(out / f'sweep_{frame:02d}_{label}.png')
            bpy.ops.render.render(write_still=True)
            print('SHOT', scene.render.filepath)


if __name__ == '__main__':
    main()

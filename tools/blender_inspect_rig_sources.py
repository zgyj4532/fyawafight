import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "models" / "rigged_v1" / "source_inspection.json"
SOURCES = [
    ROOT / "models" / "hero" / "fyagent_hero_v3_smooth.glb",
    ROOT / "models" / "fyagent_hero_rigged.glb",
    ROOT / "models" / "hero" / "fyagent_hero_v3_multiview.glb",
    ROOT / "models" / "hero" / "fyagent_hero_g1_50k.glb",
    ROOT / "models" / "enemies" / "slime.glb",
    ROOT / "models" / "enemies" / "hound.glb",
    ROOT / "models" / "enemies" / "orge.glb",
    ROOT / "models" / "enemies" / "boss_knight.glb",
    ROOT / "models" / "enemies" / "chest.glb",
]

def clear():
    bpy.ops.object.mode_set(mode='OBJECT') if bpy.context.object and bpy.context.object.mode != 'OBJECT' else None
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.actions, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)

def vec(v):
    return [round(float(x), 6) for x in v]

def inspect(path):
    clear()
    bpy.ops.import_scene.gltf(filepath=str(path), import_pack_images=True)
    deps = bpy.context.evaluated_depsgraph_get()
    all_meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    primary = max(all_meshes, key=lambda o: len(o.data.vertices)) if all_meshes else None
    meshes = [primary] if primary else []
    armatures = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    empties = [o for o in bpy.context.scene.objects if o.type == 'EMPTY']
    mins = Vector((math.inf, math.inf, math.inf))
    maxs = Vector((-math.inf, -math.inf, -math.inf))
    mesh_info = []
    for obj in meshes:
        eo = obj.evaluated_get(deps)
        corners = [eo.matrix_world @ Vector(c) for c in eo.bound_box]
        omin = Vector(tuple(min(c[i] for c in corners) for i in range(3)))
        omax = Vector(tuple(max(c[i] for c in corners) for i in range(3)))
        mins = Vector(tuple(min(mins[i], omin[i]) for i in range(3)))
        maxs = Vector(tuple(max(maxs[i], omax[i]) for i in range(3)))
        material_names = [slot.material.name if slot.material else None for slot in obj.material_slots]
        groups = [g.name for g in obj.vertex_groups]
        mesh_info.append({
            'name': obj.name,
            'data': obj.data.name,
            'vertices': len(obj.data.vertices),
            'edges': len(obj.data.edges),
            'polygons': len(obj.data.polygons),
            'bounds_min': vec(omin),
            'bounds_max': vec(omax),
            'dimensions': vec(omax - omin),
            'materials': material_names,
            'parent': obj.parent.name if obj.parent else None,
            'parent_type': obj.parent_type,
            'modifiers': [{'name': m.name, 'type': m.type, 'object': getattr(getattr(m, 'object', None), 'name', None)} for m in obj.modifiers],
            'vertex_groups': groups[:200],
            'shape_keys': list(obj.data.shape_keys.key_blocks.keys()) if obj.data.shape_keys else [],
        })
    arm_info = []
    for obj in armatures:
        arm_info.append({
            'name': obj.name,
            'bones': [{'name': b.name, 'parent': b.parent.name if b.parent else None, 'head': vec(obj.matrix_world @ b.head_local), 'tail': vec(obj.matrix_world @ b.tail_local)} for b in obj.data.bones],
            'animation': obj.animation_data.action.name if obj.animation_data and obj.animation_data.action else None,
        })
    actions = []
    for action in bpy.data.actions:
        slots = []
        try:
            slots = [{'name': s.name, 'target_id_type': s.target_id_type} for s in action.slots]
        except Exception:
            pass
        actions.append({'name': action.name, 'frame_range': vec(action.frame_range), 'slots': slots})
    return {
        'source': str(path.relative_to(ROOT)).replace('\\', '/'),
        'size_bytes': path.stat().st_size,
        'scene_objects': [{'name': o.name, 'type': o.type, 'parent': o.parent.name if o.parent else None, 'location': vec(o.location), 'rotation': vec(o.rotation_euler), 'scale': vec(o.scale)} for o in bpy.context.scene.objects],
        'mesh_count': len(meshes),
        'source_scene_mesh_count': len(all_meshes),
        'primary_mesh': primary.name if primary else None,
        'excluded_helpers': [{'name':o.name,'vertices':len(o.data.vertices),'materials':[s.material.name if s.material else None for s in o.material_slots]} for o in all_meshes if o != primary],
        'armature_count': len(armatures),
        'empty_count': len(empties),
        'bounds_min': vec(mins) if meshes else None,
        'bounds_max': vec(maxs) if meshes else None,
        'dimensions': vec(maxs - mins) if meshes else None,
        'meshes': mesh_info,
        'armatures': arm_info,
        'materials': [m.name for m in bpy.data.materials],
        'actions': actions,
    }

def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    report = {'blender': bpy.app.version_string, 'sources': []}
    for source in SOURCES:
        print(f'INSPECTING {source}')
        report['sources'].append(inspect(source))
    OUT.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(f'INSPECTION_OK {OUT}')

if __name__ == '__main__':
    main()

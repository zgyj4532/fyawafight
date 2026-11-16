import bpy
import json
from pathlib import Path
from collections import deque
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
INPUTS = {
    'slime': ROOT/'models/enemies/slime.glb',
    'hound': ROOT/'models/enemies/hound.glb',
    'ogre': ROOT/'models/enemies/orge.glb',
    'knight': ROOT/'models/enemies/boss_knight.glb',
    'chest': ROOT/'models/enemies/chest.glb',
}
OUT = ROOT/'models/rigged_v1/topology_analysis.json'

def clear():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

def components(obj):
    mesh = obj.data
    adjacency = [[] for _ in mesh.vertices]
    for edge in mesh.edges:
        a, b = edge.vertices
        adjacency[a].append(b); adjacency[b].append(a)
    seen = bytearray(len(mesh.vertices))
    result = []
    for start in range(len(mesh.vertices)):
        if seen[start]: continue
        stack = [start]; seen[start] = 1; indices = []
        while stack:
            v = stack.pop(); indices.append(v)
            for n in adjacency[v]:
                if not seen[n]: seen[n] = 1; stack.append(n)
        pts = [obj.matrix_world @ mesh.vertices[i].co for i in indices]
        mn = [min(p[k] for p in pts) for k in range(3)]
        mx = [max(p[k] for p in pts) for k in range(3)]
        result.append({'vertices': len(indices), 'min': [round(x,6) for x in mn], 'max': [round(x,6) for x in mx], 'center': [round((mn[k]+mx[k])/2,6) for k in range(3)]})
    result.sort(key=lambda x: x['vertices'], reverse=True)
    return result

def low_vertex_clusters(obj, count=4):
    points=[obj.matrix_world@v.co for v in obj.data.vertices]
    zmin=min(p.z for p in points); zmax=max(p.z for p in points)
    low=[p for p in points if p.z <= zmin+0.30*(zmax-zmin)]
    xmin=min(p.x for p in low); xmax=max(p.x for p in low)
    ymin=min(p.y for p in low); ymax=max(p.y for p in low)
    centers=[Vector((x,y,0)) for x,y in ((xmin,ymin),(xmax,ymin),(xmin,ymax),(xmax,ymax))]
    for _ in range(20):
        groups=[[] for _ in centers]
        for p in low:
            index=min(range(len(centers)),key=lambda i:(p.x-centers[i].x)**2+(p.y-centers[i].y)**2)
            groups[index].append(p)
        for i,group in enumerate(groups):
            if group:
                centers[i]=Vector((sum(p.x for p in group)/len(group),sum(p.y for p in group)/len(group),0))
    result=[]
    for center,group in zip(centers,groups):
        result.append({'count':len(group),'center_xy':[round(center.x,6),round(center.y,6)],'z_range':[round(min(p.z for p in group),6),round(max(p.z for p in group),6)]})
    return result

def main():
    report = {}
    for name, path in INPUTS.items():
        clear(); bpy.ops.import_scene.gltf(filepath=str(path), import_pack_images=True)
        mesh = max((o for o in bpy.context.scene.objects if o.type=='MESH'), key=lambda o: len(o.data.vertices))
        comps = components(mesh)
        report[name] = {'component_count': len(comps), 'components': comps[:100], 'low_vertex_clusters': low_vertex_clusters(mesh)}
        print(name, len(comps), comps[:10])
    OUT.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('TOPOLOGY_OK', OUT)
main()

import bpy
import json
import math
import sys
import traceback
from pathlib import Path
from mathutils import Matrix, Quaternion, Vector
from mathutils.kdtree import KDTree

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'models' / 'rigged_v1'
OUT.mkdir(parents=True, exist_ok=True)
FPS = 24

ASSETS = {
    'protagonist': {
        'source': ROOT/'models/fyagent_hero_rigged.glb',
        'clips': ['Idle','MoveForward','MoveBackward','StrafeLeft','StrafeRight','Shoot','Hit','Death'],
    },
    'slime': {
        'source': ROOT/'models/enemies/slime.glb',
        'clips': ['IdleSquash','HopMove','Attack','Hit','Death'],
    },
    'hound': {
        'source': ROOT/'models/enemies/hound.glb',
        'clips': ['Idle','Walk','Run','Attack','Hit','Death'],
    },
    'ogre': {
        'source': ROOT/'models/enemies/orge.glb',
        'clips': ['IdleHeavy','WalkHeavy','AttackPrimary','Hit','Death'],
    },
    'boss_knight': {
        'source': ROOT/'models/enemies/boss_knight.glb',
        'clips': ['Idle','Walk','Attack','Block','Hit','Death'],
    },
    'chest': {
        'source': ROOT/'models/enemies/chest.glb',
        'clips': ['Open','Close'],
    },
}

MANIFEST = {'blender': bpy.app.version_string, 'fps': FPS, 'assets': {}}

def clear_scene():
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj,do_unlink=True)
    for collection in (bpy.data.armatures, bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.lights, bpy.data.materials, bpy.data.images):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)


def import_primary(source, keep_armature=False):
    bpy.ops.import_scene.gltf(filepath=str(source), import_pack_images=True)
    meshes = sorted((o for o in bpy.context.scene.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices), reverse=True)
    if not meshes:
        raise RuntimeError(f'No mesh in {source}')
    primary = meshes[0]
    for obj in meshes[1:]:
        bpy.data.objects.remove(obj, do_unlink=True)
    for obj in list(bpy.context.scene.objects):
        if obj.type in {'CAMERA','LIGHT'} or (obj.type == 'EMPTY' and obj != primary.parent):
            bpy.data.objects.remove(obj, do_unlink=True)
    arms = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    arm = arms[0] if keep_armature and arms else None
    if not keep_armature:
        for obj in arms:
            bpy.data.objects.remove(obj, do_unlink=True)
    return primary, arm


def bounds(obj):
    deps = bpy.context.evaluated_depsgraph_get()
    eo = obj.evaluated_get(deps)
    points = [eo.matrix_world @ Vector(c) for c in eo.bound_box]
    mn = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    mx = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    return mn, mx


def add_bones(arm, specs):
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    made = {}
    for spec in specs:
        name, head, tail, parent, deform = spec
        b = arm.data.edit_bones.new(name)
        b.head = head
        b.tail = tail
        b.use_deform = deform
        made[name] = b
    for spec in specs:
        name, head, tail, parent, deform = spec
        if parent:
            made[name].parent = made[parent]
    bpy.ops.object.mode_set(mode='OBJECT')


def create_armature(name, specs):
    data = bpy.data.armatures.new(name + 'Data')
    arm = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(arm)
    arm.show_in_front = True
    arm.data.display_type = 'STICK'
    add_bones(arm, specs)
    return arm


def attach_and_weight(mesh, arm, rigid=False, max_influences=3):
    mesh.parent = arm
    mesh.matrix_parent_inverse = arm.matrix_world.inverted()
    mod = mesh.modifiers.new('ArmatureDeform', 'ARMATURE')
    mod.object = arm
    deform = [b for b in arm.data.bones if b.use_deform]
    groups = {b.name: mesh.vertex_groups.new(name=b.name) for b in deform}
    segments = []
    inv_mesh = mesh.matrix_world.inverted()
    for b in deform:
        a_world = arm.matrix_world @ b.head_local
        z_world = arm.matrix_world @ b.tail_local
        segments.append((b.name, inv_mesh @ a_world, inv_mesh @ z_world))
    def distance_sq(p, a, z):
        az = z - a
        denom = az.length_squared
        if denom < 1e-12:
            return (p-a).length_squared
        t = max(0.0, min(1.0, (p-a).dot(az)/denom))
        return (p - (a + t*az)).length_squared
    mesh_min, mesh_max = bounds(mesh)
    eps = max((mesh_max-mesh_min).length * 0.006, 1e-5)
    for vert in mesh.data.vertices:
        ranked = sorted((distance_sq(vert.co, a, z), name) for name, a, z in segments)
        if rigid:
            groups[ranked[0][1]].add([vert.index], 1.0, 'REPLACE')
        else:
            chosen = ranked[:max_influences]
            raw = [1.0/(math.sqrt(d)+eps)**2 for d, _ in chosen]
            total = sum(raw)
            for weight, (_, name) in zip(raw, chosen):
                groups[name].add([vert.index], weight/total, 'REPLACE')


def cohere_existing_component_weights(mesh, arm):
    """Preserve source weight intent while preventing one island from tearing internally."""
    deform_names={bone.name for bone in arm.data.bones if bone.use_deform}
    groups={group.name:group for group in mesh.vertex_groups if group.name in deform_names}
    center_x=arm.data.bones['mixamorig:Hips'].head_local.x
    for component in connected_components(mesh):
        component_x=sum(mesh.data.vertices[index].co.x for index in component)/len(component)
        scores={}
        for index in component:
            for assignment in mesh.data.vertices[index].groups:
                source_name=mesh.vertex_groups[assignment.group].name
                if source_name not in deform_names:
                    continue
                target_name=source_name
                if component_x<center_x and 'Left' in target_name:
                    target_name=target_name.replace('Left','Right')
                elif component_x>center_x and 'Right' in target_name:
                    target_name=target_name.replace('Right','Left')
                if target_name in groups:
                    scores[target_name]=scores.get(target_name,0.0)+assignment.weight
        selected=sorted(scores.items(),key=lambda item:item[1],reverse=True)[:4]
        total=sum(weight for _,weight in selected)
        if total<=0:
            raise RuntimeError('Protagonist component has no usable source deformation weights')
        for index in component:
            for assignment in list(mesh.data.vertices[index].groups):
                group=mesh.vertex_groups[assignment.group]
                if group.name in deform_names:
                    group.remove([index])
            for name,weight in selected:
                groups[name].add([index],weight/total,'REPLACE')
    mesh.data.update()


def add_existing_hero_controls(arm):
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    hips = eb.get('mixamorig:Hips')
    if not hips:
        raise RuntimeError('Existing hero rig is missing mixamorig:Hips')
    root = eb.new('GameRoot')
    root.head = Vector((hips.head.x, hips.head.y, min(b.head.z for b in eb)))
    root.tail = root.head + Vector((0, 0, max((hips.tail-hips.head).length, 0.005)))
    root.use_deform = False
    hips.parent = root
    def socket(name, parent_name, offset):
        parent = eb[parent_name]
        b = eb.new(name)
        b.head = parent.tail
        b.tail = parent.tail + Vector(offset)
        b.parent = parent
        b.use_deform = False
        return b
    ls = socket('HandSocket.L', 'mixamorig:LeftHand', (0, -0.004, 0.002))
    rs = socket('HandSocket.R', 'mixamorig:RightHand', (0, -0.004, 0.002))
    weapon = socket('WeaponSocket.R', 'mixamorig:RightHand', (0, -0.008, 0.001))
    muzzle = eb.new('MuzzleSocket')
    muzzle.head = weapon.tail
    muzzle.tail = weapon.tail + Vector((0, -0.008, 0))
    muzzle.parent = weapon
    muzzle.use_deform = False
    socket('HeadSocket', 'mixamorig:Head', (0, 0, 0.006))
    bpy.ops.object.mode_set(mode='OBJECT')


def B(name, head, tail, parent=None, deform=True):
    return (name, Vector(head), Vector(tail), parent, deform)


def humanoid_specs(mn, mx, heavyweight=False, knight=False):
    c = (mn + mx) * 0.5; w = mx.x-mn.x; h = mx.z-mn.z
    z0 = mn.z
    foot = z0 + 0.035*h; knee = z0 + (0.27 if heavyweight else 0.29)*h
    hip = z0 + (0.50 if heavyweight else 0.52)*h
    belly = z0 + (0.61 if heavyweight else 0.64)*h
    chest = z0 + (0.73 if heavyweight else 0.76)*h
    neck = z0 + (0.83 if heavyweight else 0.86)*h
    head = z0 + (0.94 if heavyweight else 0.96)*h
    lx = (0.15 if heavyweight else 0.17)*w
    shoulder_x = (0.28 if heavyweight else 0.27)*w
    elbow_x = (0.36 if heavyweight else 0.37)*w
    hand_x = (0.42 if heavyweight else 0.44)*w
    shoulder_z = z0 + (0.72 if heavyweight else 0.75)*h
    elbow_z = z0 + (0.57 if heavyweight else 0.56)*h
    hand_z = z0 + (0.40 if heavyweight else 0.39)*h
    y = c.y
    specs = [
        B('Root',(c.x,y,z0),(c.x,y,z0+0.06*h),None,False),
        B('Pelvis',(c.x,y,hip),(c.x,y,belly),'Root'),
        B('Spine',(c.x,y,belly),(c.x,y,chest),'Pelvis'),
        B('Chest',(c.x,y,chest),(c.x,y,neck),'Spine'),
        B('Neck',(c.x,y,neck),(c.x,y,head-0.03*h),'Chest'),
        B('Head',(c.x,y,head-0.03*h),(c.x,y,mx.z-0.01*h),'Neck'),
    ]
    for side, sign in [('L',1),('R',-1)]:
        xleg = c.x + sign*lx
        specs += [
            B(f'Thigh.{side}',(xleg,y,hip),(xleg,y,knee),'Pelvis'),
            B(f'Shin.{side}',(xleg,y,knee),(xleg,y,foot),'Thigh.'+side),
            B(f'Foot.{side}',(xleg,y,foot),(xleg,y-0.10*(mx.y-mn.y),foot),'Shin.'+side),
            B(f'UpperArm.{side}',(c.x+sign*shoulder_x,y,shoulder_z),(c.x+sign*elbow_x,y,elbow_z),'Chest'),
            B(f'Forearm.{side}',(c.x+sign*elbow_x,y,elbow_z),(c.x+sign*hand_x,y,hand_z),'UpperArm.'+side),
            B(f'Hand.{side}',(c.x+sign*hand_x,y,hand_z),(c.x+sign*(hand_x+0.015*w),y,hand_z-0.04*h),'Forearm.'+side),
            B(f'HandSocket.{side}',(c.x+sign*hand_x,y,hand_z),(c.x+sign*(hand_x+0.02*w),y-0.03*(mx.y-mn.y),hand_z),f'Hand.{side}',False),
        ]
    if knight:
        specs += [
            B('WeaponSocket',(c.x-w*0.44,y,hand_z),(c.x-w*0.44,y-0.08*(mx.y-mn.y),hand_z),'Hand.R',False),
        ]
    if heavyweight:
        belly_z=z0+0.50*h
        specs.append(B('Belly',(c.x,y-0.04*(mx.y-mn.y),belly_z),(c.x,mn.y+0.10*(mx.y-mn.y),belly_z-0.02*h),'Spine'))
    return specs


def hound_landmarks(mesh):
    mn,mx=bounds(mesh); h=mx.z-mn.z
    low=[mesh.matrix_world@v.co for v in mesh.data.vertices if (mesh.matrix_world@v.co).z <= mn.z+0.30*h]
    xmin=min(p.x for p in low); xmax=max(p.x for p in low); ymin=min(p.y for p in low); ymax=max(p.y for p in low)
    centers=[Vector((x,y,0)) for x,y in ((xmin,ymin),(xmax,ymin),(xmin,ymax),(xmax,ymax))]
    for _ in range(20):
        groups=[[] for _ in centers]
        for p in low:
            index=min(range(4),key=lambda i:(p.x-centers[i].x)**2+(p.y-centers[i].y)**2)
            groups[index].append(p)
        for i,group in enumerate(groups):
            if group:
                centers[i]=Vector((sum(p.x for p in group)/len(group),sum(p.y for p in group)/len(group),0))
    ordered=sorted(centers,key=lambda p:p.y)
    front=sorted(ordered[:2],key=lambda p:p.x)
    back=sorted(ordered[2:],key=lambda p:p.x)
    return {
        'Front.R':front[0], 'Front.L':front[1],
        'Back.R':back[0], 'Back.L':back[1],
        'front_mid':(front[0]+front[1])*0.5, 'rear_mid':(back[0]+back[1])*0.5,
    }


def hound_specs(mesh):
    mn,mx=bounds(mesh); c=(mn+mx)*0.5; d=mx.y-mn.y; h=mx.z-mn.z
    marks=hound_landmarks(mesh); front=marks['front_mid']; rear=marks['rear_mid']
    direction=(front-rear).normalized(); body_z=mn.z+0.59*h; shoulder_z=mn.z+0.58*h
    spine_mid=(front+rear)*0.5
    neck_xy=front+direction*0.12*d; head_xy=front+direction*0.28*d
    tail1=rear-direction*0.17*d; tail2=rear-direction*0.31*d
    specs=[
        B('Root',(spine_mid.x,spine_mid.y,mn.z),(spine_mid.x,spine_mid.y,mn.z+0.08*h),None,False),
        B('Pelvis',(rear.x,rear.y,body_z),(spine_mid.x,spine_mid.y,body_z),'Root'),
        B('Spine',(spine_mid.x,spine_mid.y,body_z),(front.x,front.y,body_z+0.04*h),'Pelvis'),
        B('Neck',(front.x,front.y,body_z+0.04*h),(neck_xy.x,neck_xy.y,mn.z+0.73*h),'Spine'),
        B('Head',(neck_xy.x,neck_xy.y,mn.z+0.73*h),(head_xy.x,head_xy.y,mn.z+0.69*h),'Neck'),
        B('Tail.01',(rear.x,rear.y,body_z),(tail2.x,tail2.y,body_z+0.15*h),'Pelvis'),
    ]
    for label in ('Front','Back'):
        parent='Spine' if label=='Front' else 'Pelvis'
        midline=front if label=='Front' else rear
        for side in ('L','R'):
            paw=marks[f'{label}.{side}']
            shoulder_xy=paw*0.72+midline*0.28
            elbow_xy=paw*0.90+shoulder_xy*0.10
            specs += [
                B(f'{label}Upper.{side}',(shoulder_xy.x,shoulder_xy.y,shoulder_z),(elbow_xy.x,elbow_xy.y,mn.z+0.29*h),parent),
                B(f'{label}Lower.{side}',(elbow_xy.x,elbow_xy.y,mn.z+0.29*h),(paw.x,paw.y,mn.z+0.045*h),f'{label}Upper.{side}'),
                B(f'{label}Paw.{side}',(paw.x,paw.y,mn.z+0.045*h),(paw.x+direction.x*0.08*d,paw.y+direction.y*0.08*d,mn.z+0.045*h),f'{label}Lower.{side}'),
            ]
    return specs


def slime_specs(mn,mx):
    c=(mn+mx)*0.5; h=mx.z-mn.z
    return [
        B('SlimeRoot',(c.x,c.y,mn.z),(c.x,c.y,mn.z+0.10*h),None,False),
        B('SlimeCore',(c.x,c.y,mn.z+0.08*h),(c.x,c.y,mx.z-0.01*h),'SlimeRoot'),
    ]


def chest_specs(mn,mx):
    c=(mn+mx)*0.5; h=mx.z-mn.z; d=mx.y-mn.y
    seam=mn.z+0.55*h
    hinge_y=mx.y-0.08*d
    return [
        B('ChestRoot',(c.x,c.y,mn.z),(c.x,c.y,seam),None,True),
        B('ChestLid',(c.x,hinge_y,seam),(c.x+0.20*(mx.x-mn.x),hinge_y,seam),'ChestRoot',True),
    ], seam


def connected_components(mesh):
    adjacency=[[] for _ in mesh.data.vertices]
    for edge in mesh.data.edges:
        a,b=edge.vertices; adjacency[a].append(b); adjacency[b].append(a)
    components=[]; seen=bytearray(len(mesh.data.vertices))
    for start in range(len(mesh.data.vertices)):
        if seen[start]:
            continue
        stack=[start]; seen[start]=1; component=[]
        while stack:
            index=stack.pop(); component.append(index)
            for neighbor in adjacency[index]:
                if not seen[neighbor]:
                    seen[neighbor]=1; stack.append(neighbor)
        components.append(component)
    return components


def weight_chest(mesh, arm, seam):
    assignments={'ChestRoot':[],'ChestLid':[]}
    for component in connected_components(mesh):
        above=sum(1 for index in component if (mesh.matrix_world@mesh.data.vertices[index].co).z >= seam)
        owner='ChestLid' if above*2 >= len(component) else 'ChestRoot'
        assignments[owner].extend(component)
    attach_rigid_groups(mesh,arm,assignments)

def attach_rigid_groups(mesh, arm, assignments):
    mesh.parent=arm; mesh.matrix_parent_inverse=arm.matrix_world.inverted()
    mod=mesh.modifiers.new('ArmatureDeform','ARMATURE'); mod.object=arm
    groups={b.name:mesh.vertex_groups.new(name=b.name) for b in arm.data.bones if b.use_deform}
    for bone_name, indices in assignments.items():
        if indices:
            groups[bone_name].add(indices,1.0,'REPLACE')


def weight_slime(mesh, arm):
    mesh.parent=arm; mesh.matrix_parent_inverse=arm.matrix_world.inverted()
    mod=mesh.modifiers.new('ArmatureDeform','ARMATURE'); mod.object=arm
    core=mesh.vertex_groups.new(name='SlimeCore')
    core.add([v.index for v in mesh.data.vertices],1.0,'REPLACE')


def weight_hound(mesh, arm):
    mn,mx=bounds(mesh); h=mx.z-mn.z; marks=hound_landmarks(mesh)
    front=marks['front_mid']; rear=marks['rear_mid']; axis=rear-front; axis_len=max(axis.length,1e-6); axis.normalize()
    def owner(point):
        if point.z < mn.z+0.48*h:
            limb=min((f'{label}.{side}' for label in ('Front','Back') for side in ('L','R')),
                     key=lambda key:(point.x-marks[key].x)**2+(point.y-marks[key].y)**2)
            label,side=limb.split('.')
            nz=(point.z-mn.z)/h
            segment='Paw' if nz<0.12 else ('Lower' if nz<0.31 else 'Upper')
            return f'{label}{segment}.{side}'
        projection=(Vector((point.x,point.y,0))-front).dot(axis)/axis_len
        if projection < -0.13:
            return 'Head'
        if projection < 0.10:
            return 'Neck'
        if projection > 1.02:
            return 'Tail.01'
        return 'Pelvis' if projection>0.58 else 'Spine'
    assignments={b.name:[] for b in arm.data.bones if b.use_deform}
    infos=[]
    for component in connected_components(mesh):
        points=[mesh.matrix_world@mesh.data.vertices[index].co for index in component]
        counts={}
        for point in points:
            name=owner(point); counts[name]=counts.get(name,0)+1
        infos.append({'indices':component,'center':sum(points,Vector())/len(points),'classified':max(counts,key=counts.get)})
    limb_names={f'{label}{segment}.{side}' for label in ('Front','Back') for segment in ('Upper','Lower','Paw') for side in ('L','R')}
    anchors=[info for info in infos if len(info['indices'])>=150]
    for info in infos:
        if info['classified'] in limb_names:
            info['assigned']=info['classified']
        else:
            info['assigned']=info['classified'] if info in anchors else min(anchors,key=lambda anchor:(info['center']-anchor['center']).length_squared)['classified']
    for info in infos:
        if len(info['indices'])<150 and info['classified'] not in limb_names:
            neighbors=sorted((other for other in infos if other is not info),key=lambda other:(info['center']-other['center']).length_squared)[:12]
            votes={}
            for neighbor in neighbors:
                name=neighbor['assigned']; votes[name]=votes.get(name,0)+1
            info['assigned']=max(votes,key=votes.get)
        assignments[info['assigned']].extend(info['indices'])
    attach_rigid_groups(mesh,arm,assignments)


def weight_ogre(mesh, arm):
    mn,mx=bounds(mesh); c=(mn+mx)*0.5; w=mx.x-mn.x; d=mx.y-mn.y; h=mx.z-mn.z
    deform=[bone for bone in arm.data.bones if bone.use_deform]
    inv_mesh=mesh.matrix_world.inverted()
    segments=[]
    for bone in deform:
        segments.append((bone.name,inv_mesh@(arm.matrix_world@bone.head_local),inv_mesh@(arm.matrix_world@bone.tail_local)))
    def distance_sq(point,start,end):
        axis=end-start
        if axis.length_squared<1e-12:
            return (point-start).length_squared
        factor=max(0.0,min(1.0,(point-start).dot(axis)/axis.length_squared))
        return (point-(start+factor*axis)).length_squared
    components=connected_components(mesh)
    infos=[]
    central_names={'Pelvis','Spine','Chest','Neck','Head'}
    for component in components:
        points=[mesh.data.vertices[index].co for index in component]
        center=sum(points,Vector())/len(points)
        extent_x=max(point.x for point in points)-min(point.x for point in points)
        candidates=[segment for segment in segments if segment[0] in central_names] if extent_x>0.45*w or abs(center.x-c.x)<0.08*w else segments
        owner=min(candidates,key=lambda segment:distance_sq(center,segment[1],segment[2]))[0]
        infos.append({'indices':component,'center':center,'owner':owner,
                      'min':Vector(tuple(min(point[axis] for point in points) for axis in range(3))),
                      'max':Vector(tuple(max(point[axis] for point in points) for axis in range(3)))})
    vertex_component=[-1]*len(mesh.data.vertices)
    for component_index,component in enumerate(components):
        for vertex_index in component:
            vertex_component[vertex_index]=component_index
    surface_groups={}
    for vertex in mesh.data.vertices:
        key=tuple(round(float(value),5) for value in vertex.co)
        surface_groups.setdefault(key,[]).append(vertex.index)
    contact_counts=[{} for _ in components]
    for indices in surface_groups.values():
        touched=sorted({vertex_component[index] for index in indices})
        for component_a in touched:
            for component_b in touched:
                if component_a!=component_b:
                    contact_counts[component_a][component_b]=contact_counts[component_a].get(component_b,0)+1
    segment_by_name={name:(start,end) for name,start,end in segments}
    def upper_arm_factor(info):
        side='L' if info['center'].x>=c.x else 'R'
        start,end=segment_by_name[f'UpperArm.{side}']; axis=end-start
        return 0.0 if axis.length_squared<1e-12 else (info['center']-start).dot(axis)/axis.length_squared
    arm_chain={'UpperArm.L','UpperArm.R','Forearm.L','Forearm.R','Hand.L','Hand.R'}
    for _ in range(3):
        updates={}
        for component_index,info in enumerate(infos):
            center=info['center']; nx=abs(center.x-c.x)/w; nz=(center.z-mn.z)/h
            if info['owner'] in arm_chain and (not info['owner'].startswith('UpperArm.') or upper_arm_factor(info)>0.35):
                continue
            if nx>0.34 or (info['owner'] in central_names and nz<0.70):
                continue
            central_neighbors=[]
            for neighbor,count in contact_counts[component_index].items():
                neighbor_owner=infos[neighbor]['owner']
                neighbor_nz=(infos[neighbor]['center'].z-mn.z)/h
                if neighbor_owner in {'Spine','Chest','Neck'} and neighbor_nz>=0.60:
                    central_neighbors.append((len(infos[neighbor]['indices']),count,neighbor_owner))
            if central_neighbors:
                updates[component_index]=max(central_neighbors)[2]
        for component_index,owner in updates.items():
            infos[component_index]['owner']=owner
    shoulder_components={
        index for index,info in enumerate(infos)
        if 0.15<=abs(info['center'].x-c.x)/w<=0.34
        and 0.70<=(info['center'].z-mn.z)/h<=0.90
        and (info['owner'] in central_names
             or (info['owner'] in {'UpperArm.L','UpperArm.R'} and upper_arm_factor(info)<=0.35))
    }
    torso_surface=set(shoulder_components)
    for _ in range(2):
        for component_index in tuple(torso_surface):
            for neighbor in contact_counts[component_index]:
                neighbor_nz=(infos[neighbor]['center'].z-mn.z)/h
                if infos[neighbor]['owner'] in {'Spine','Chest','Neck'} and neighbor_nz>=0.45:
                    torso_surface.add(neighbor)
    for component_index in torso_surface:
        if component_index in shoulder_components or infos[component_index]['owner'] in {'Spine','Chest','Neck'}:
            infos[component_index]['owner']='Chest'
    chest_cluster={component_index for component_index in torso_surface if infos[component_index]['owner']=='Chest'}
    boundary_contacts={
        neighbor
        for component_index in chest_cluster
        for neighbor in contact_counts[component_index]
        if infos[neighbor]['owner'] in {'UpperArm.L','UpperArm.R'} and upper_arm_factor(infos[neighbor])<=0.35
    }
    for component_index in boundary_contacts:
        infos[component_index]['owner']='Chest'
    for info in infos:
        nx=abs(info['center'].x-c.x)/w; nz=(info['center'].z-mn.z)/h
        if nx<0.22 and nz>=0.86 and info['owner'] in central_names:
            info['owner']='Head'
    for info in infos:
        center=info['center']
        lateral=abs(center.x-c.x)/w
        forward=(c.y-center.y)/d
        height=(center.z-mn.z)/h
        if lateral<0.22 and forward>0.16 and 0.38<height<0.70 and (info['max'].x-info['min'].x)<0.50*w:
            info['owner']='Belly'
    print('OGRE_BELLY', sum(len(info['indices']) for info in infos if info['owner']=='Belly'))
    assignments={bone.name:[] for bone in deform}
    for info in infos:
        assignments[info['owner']].extend(info['indices'])
    attach_rigid_groups(mesh,arm,assignments)
    # The source's largest continuous skin island spans the chest and both arms.
    # Use a deterministic piecewise blend across that whole contact cluster so
    # coincident fragments receive identical weights while rigid armor islands
    # outside the cluster retain their anatomical owner.
    groups={group.name:group for group in mesh.vertex_groups}
    blend_indices=set()
    for info in infos:
        if info['owner']=='Belly':
            continue
        if info['owner']=='Chest' or info['owner'] in arm_chain:
            blend_indices.update(info['indices'])
    def smoothstep(value):
        value=max(0.0,min(1.0,value))
        return value*value*(3.0-2.0*value)
    def arm_weights(point):
        lateral=abs(point.x-c.x)/max(w,1e-8)
        side='L' if point.x>=c.x else 'R'
        upper=f'UpperArm.{side}'; fore=f'Forearm.{side}'; hand=f'Hand.{side}'
        if lateral<=0.27:
            return {'Chest':1.0}
        if lateral<0.33:
            t=smoothstep((lateral-0.27)/0.06)
            return {'Chest':1.0-t,upper:t}
        if lateral<=0.355:
            return {upper:1.0}
        if lateral<0.405:
            t=smoothstep((lateral-0.355)/0.05)
            return {upper:1.0-t,fore:t}
        if lateral<=0.425:
            return {fore:1.0}
        if lateral<0.465:
            t=smoothstep((lateral-0.425)/0.04)
            return {fore:1.0-t,hand:t}
        return {hand:1.0}
    deform_names={bone.name for bone in arm.data.bones if bone.use_deform}
    for index in blend_indices:
        for assignment in list(mesh.data.vertices[index].groups):
            group=mesh.vertex_groups[assignment.group]
            if group.name in deform_names:
                group.remove([index])
        for name,weight in arm_weights(mesh.data.vertices[index].co).items():
            if weight>1e-6:
                groups[name].add([index],weight,'REPLACE')
    mesh.data.update()


def blade_component_indices(mesh, cape_ids):
    """Keep the longsword, and leave the armor cloud that sits beside it on the body.

    Image-to-3D stacked several thin blade shells and also left a wide mass of
    hip and hand armor within a few centimeters of them. Binding that mass to
    the sword makes the slash throw a second blade.
    """
    points=[mesh.matrix_world@vertex.co for vertex in mesh.data.vertices]
    selected=[]
    for component in connected_components(mesh):
        if len(component)<8 or any(index in cape_ids for index in component):
            continue
        coords=[points[index] for index in component]
        low=[min(point[axis] for point in coords) for axis in range(3)]
        high=[max(point[axis] for point in coords) for axis in range(3)]
        span=[high[axis]-low[axis] for axis in range(3)]
        center=sum(coords, Vector())/len(coords)
        if span[2]<0.75 or span[0]>0.36 or span[1]>0.22 or center.x>-0.25 or center.y>-0.05:
            continue
        selected.extend(component)
        print('BLADE_ISLAND', len(component), 'span', [round(value, 3) for value in span])
    if len(selected)<80:
        raise RuntimeError(f'Knight blade islands were not found ({len(selected)} vertices)')
    tree=KDTree(len(selected))
    for slot, index in enumerate(selected):
        tree.insert(points[index], slot)
    tree.balance()
    # Guards and duplicate shells sit on the blade. A thigh island that only
    # touches it has a large median distance and stays on the body.
    for component in connected_components(mesh):
        if len(component)<8 or len(component)>160 or any(index in cape_ids or index in selected for index in component):
            continue
        distances=sorted(tree.find(points[index])[2] for index in component)
        if distances[len(distances)//2]<=0.02:
            selected.extend(component)
            print('BLADE_SHELL', len(component), 'median', round(distances[len(distances)//2], 4))
    return selected


def refit_sword_bone(arm, mesh, indices):
    """Put the sword bone through the visible blade. The old axis sat beside it, so the mesh orbited instead of cutting."""
    points=[mesh.matrix_world@mesh.data.vertices[index].co for index in indices]
    ordered=sorted(points, key=lambda point: point.z)
    count=max(8, len(ordered)//12)
    grip=sum(ordered[-count:], Vector())/count
    tip=sum(ordered[:count], Vector())/count
    if (tip-grip).length<0.2:
        raise RuntimeError('Knight blade endpoints are too close to refit')
    bpy.context.view_layer.objects.active=arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bone=arm.data.edit_bones['Sword']
    bone.use_connect=False
    local=arm.matrix_world.inverted()
    bone.head=local@grip
    bone.tail=local@tip
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.update()
    print('SWORD_REFIT', [round(float(value), 3) for value in grip], [round(float(value), 3) for value in tip])


def weight_knight(mesh, arm):
    mn,mx=bounds(mesh); c=(mn+mx)*0.5; w=mx.x-mn.x; d=mx.y-mn.y; h=mx.z-mn.z
    infos=[]
    for component in connected_components(mesh):
        points=[mesh.matrix_world@mesh.data.vertices[i].co for i in component]
        cmn=Vector(tuple(min(p[k] for p in points) for k in range(3)))
        cmx=Vector(tuple(max(p[k] for p in points) for k in range(3)))
        infos.append({'indices':component,'center':sum(points,Vector())/len(points),'min':cmn,'max':cmx,'extent':cmx-cmn})
    def classify(info):
        p=info['center']; extent=info['extent']; nx=(p.x-c.x)/w; ny=(p.y-c.y)/d; nz=(p.z-mn.z)/h
        side='L' if nx>0 else 'R'
        if nz<0.42 and abs(nx)<0.22:
            return 'Pelvis'
        if ny>0.16 and (extent.z>0.18*h or nz>0.28):
            return 'Chest'
        if extent.z>0.44*h and extent.x<0.30*w and abs(nx)>0.30:
            return f'Hand.{side}'
        if nz>0.84: return 'Head'
        if abs(nx)>0.23 and nz>0.31:
            return f'UpperArm.{side}' if nz>0.65 else (f'Forearm.{side}' if nz>0.46 else f'Hand.{side}')
        if nz<0.12: return f'Foot.{side}'
        if nz<0.36: return f'Shin.{side}'
        if nz<0.54 and abs(nx)>0.06: return f'Thigh.{side}'
        if nz<0.58: return 'Pelvis'
        if nz<0.72: return 'Spine'
        return 'Chest'
    for info in infos:
        info['classified']=classify(info)
        p=info['center']; info['waist']=(p.z-mn.z)/h<0.42 and abs((p.x-c.x)/w)<0.22
    anchors=[info for info in infos if len(info['indices'])>=80]
    for info in anchors:
        info['owner']=info['classified']
    leg_names={f'{segment}.{side}' for segment in ('Thigh','Shin','Foot') for side in ('L','R')}
    assignments={b.name:[] for b in arm.data.bones if b.use_deform}
    for info in infos:
        if info['waist']:
            owner='Pelvis'
        elif info['classified'] in leg_names:
            owner=info['classified']
        elif info in anchors:
            owner=info['owner']
        else:
            nearest=min(anchors,key=lambda anchor:(info['center']-anchor['center']).length_squared)
            owner=nearest['owner']
            p=info['center']; nx=(p.x-c.x)/w; nz=(p.z-mn.z)/h
            if abs(nx)>0.40 and 0.15<nz<0.72:
                owner=f'Hand.{"L" if nx>0 else "R"}'
        info['assigned']=owner
    for info in infos:
        if len(info['indices'])<80 and info['classified'] not in leg_names and not info['waist']:
            neighbors=sorted((other for other in infos if other is not info),key=lambda other:(info['center']-other['center']).length_squared)[:12]
            votes={}
            for neighbor in neighbors:
                name=neighbor['assigned']; votes[name]=votes.get(name,0)+1
            info['assigned']=max(votes,key=votes.get)
    def arm_owner(name):
        return str(name).startswith(('UpperArm','Forearm','Hand'))
    for _ in range(4):
        changed=False
        for info in infos:
            if not arm_owner(info['assigned']) or info['center'].z>0.05:
                continue
            candidates=[other for other in infos if other is not info and not arm_owner(other['assigned'])]
            if not candidates:
                continue
            nearest=min(candidates, key=lambda other:(info['center']-other['center']).length)
            if (info['center']-nearest['center']).length<0.12:
                info['assigned']=nearest['assigned']
                changed=True
        if not changed:
            break
    for _ in range(6):
        changed=False
        for info in infos:
            if len(info['indices'])>8:
                continue
            larger=[other for other in infos if len(other['indices'])>len(info['indices'])]
            if not larger:
                continue
            nearest=min(larger, key=lambda other:(info['center']-other['center']).length)
            if info['assigned']!=nearest['assigned'] and (info['center']-nearest['center']).length<0.08:
                info['assigned']=nearest['assigned']
                changed=True
        if not changed:
            break
    for info in infos:
        assignments[info['assigned']].extend(info['indices'])
    analysis=analyze_knight(mesh)
    cape_ids=set()
    for band in analysis['cape_bands']:
        cape_ids.update(band)
    if sum(len(band) for band in analysis['cape_bands'])<400:
        raise RuntimeError('Knight cape region is too small')
    blade=blade_component_indices(mesh, cape_ids)
    blade_set=set(blade)
    for name in list(assignments):
        assignments[name]=[index for index in assignments[name] if index not in blade_set and index not in cape_ids]
    assignments['Sword']=blade
    for name,band in zip(CAPE_NAMES,analysis['cape_bands']):
        assignments[name]=list(band)
    refit_sword_bone(arm, mesh, blade)
    print('KNIGHT_REGIONS', 'sword', len(blade), 'cape', [len(band) for band in analysis['cape_bands']])
    attach_rigid_groups(mesh,arm,assignments)




def local_location_for_world_delta(arm, bone_name, world_delta):
    bone=arm.data.bones[bone_name]
    if bone.parent is not None:
        raise RuntimeError(f'{bone_name} must be parentless for world-space motion authoring')
    armature_delta=arm.matrix_world.to_3x3().inverted()@Vector(world_delta)
    return tuple(bone.matrix_local.to_3x3().inverted()@armature_delta)
def pose_reset(arm):
    for p in arm.pose.bones:
        p.location=(0,0,0); p.rotation_mode='XYZ'; p.rotation_euler=(0,0,0); p.scale=(1,1,1)


def assign_action(arm, action):
    arm.animation_data_create()
    arm.animation_data.action=action
    slots=list(getattr(action, 'slots', []) or []) if action is not None else []
    if slots and hasattr(arm.animation_data, 'action_slot'):
        arm.animation_data.action_slot=slots[0]


def _segment_distance(point, head, tail):
    axis=tail-head
    if axis.length_squared<1e-12:
        return (point-head).length
    factor=max(0.0, min(1.0, (point-head).dot(axis)/axis.length_squared))
    return (point-(head+axis*factor)).length


def make_action(arm, name, frames, keys, layer='FullBody'):
    action=bpy.data.actions.new(name)
    action.use_fake_user=True
    action['clip_name']=name
    action['layer']=layer
    arm.animation_data_create()
    arm.animation_data.action=action
    identity={'loc':(0,0,0),'rot':(0,0,0),'scale':(1,1,1)}
    used={}
    for frame_data in keys.values():
        for bone_name,channels in frame_data.items():
            used.setdefault(bone_name,set()).update(channels)
    action['authored_channels']=json.dumps(sorted((bone_name,channel) for bone_name,channels in used.items() for channel in channels))
    for boundary in (min(frames),max(frames)):
        frame_data=keys.setdefault(boundary,{})
        for bone_name,channels in used.items():
            authored=frame_data.setdefault(bone_name,{})
            for channel in channels:
                authored.setdefault(channel,identity[channel])
    pose_reset(arm)
    for frame in frames:
        pose_reset(arm)
        for bone_name, channels in keys.get(frame, {}).items():
            pb=arm.pose.bones.get(bone_name)
            if not pb:
                continue
            if 'loc' in channels: pb.location=channels['loc']
            if 'rot' in channels: pb.rotation_euler=channels['rot']
            if 'scale' in channels: pb.scale=channels['scale']
            for path in ('location','rotation_euler','scale'):
                if {'location':'loc','rotation_euler':'rot','scale':'scale'}[path] in channels:
                    pb.keyframe_insert(data_path=path,frame=frame,group=bone_name)
    action['frame_start']=min(frames); action['frame_end']=max(frames)
    arm.animation_data.action=None
    pose_reset(arm)
    return action


def finalize_actions(arm, clip_names):
    identity={'loc':(0,0,0),'rot':(0,0,0),'scale':(1,1,1)}
    union=set()
    actions=[]
    for name in clip_names:
        action=bpy.data.actions[name]
        actions.append(action)
        union.update(tuple(item) for item in json.loads(action['authored_channels']))
    for action in actions:
        authored={tuple(item) for item in json.loads(action['authored_channels'])}
        arm.animation_data.action=action
        for frame in (int(action['frame_start']),int(action['frame_end'])):
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            for bone_name,channel in union-authored:
                pb=arm.pose.bones[bone_name]
                if channel=='loc':
                    pb.location=identity[channel]
                    pb.keyframe_insert(data_path='location',frame=frame,group=bone_name)
                elif channel=='rot':
                    pb.rotation_euler=identity[channel]
                    pb.keyframe_insert(data_path='rotation_euler',frame=frame,group=bone_name)
                else:
                    pb.scale=identity[channel]
                    pb.keyframe_insert(data_path='scale',frame=frame,group=bone_name)
    arm.animation_data.action=None
    bpy.context.scene.frame_set(1)
    pose_reset(arm)
    bpy.context.view_layer.update()


HERO_ARM_BONES=(
    'mixamorig:LeftShoulder','mixamorig:LeftArm','mixamorig:LeftForeArm','mixamorig:LeftHand',
    'mixamorig:RightShoulder','mixamorig:RightArm','mixamorig:RightForeArm','mixamorig:RightHand',
)


def _is_finger(name):
    return 'Hand' in name and not name.endswith('Hand') and 'Socket' not in name


def bind_hero_arms(mesh, arm):
    """Put sleeve islands on the arm bones and take the coat back off the forearms."""
    segments=[]
    for bone in arm.data.bones:
        if not bone.use_deform or _is_finger(bone.name):
            continue
        head=arm.matrix_world@bone.head_local
        tail=arm.matrix_world@bone.tail_local
        kind='arm' if bone.name in HERO_ARM_BONES else 'torso'
        segments.append((bone.name, head, tail, (tail-head).length, kind))
    groups={}
    for bone in arm.data.bones:
        if not bone.use_deform:
            continue
        group=mesh.vertex_groups.get(bone.name)
        if group is None:
            group=mesh.vertex_groups.new(name=bone.name)
        groups[bone.name]=group
    deform_names=set(groups)
    to_arm=0
    to_torso=0
    for component in connected_components(mesh):
        center=sum((mesh.matrix_world@mesh.data.vertices[index].co for index in component), Vector())/len(component)
        arm_best=min((item for item in segments if item[4]=='arm'), key=lambda item: _segment_distance(center, item[1], item[2]))
        torso_best=min((item for item in segments if item[4]=='torso'), key=lambda item: _segment_distance(center, item[1], item[2]))
        arm_dist=_segment_distance(center, arm_best[1], arm_best[2])
        torso_dist=_segment_distance(center, torso_best[1], torso_best[2])
        scores={}
        for index in component:
            for assignment in mesh.data.vertices[index].groups:
                name=mesh.vertex_groups[assignment.group].name
                if name in deform_names:
                    scores[name]=scores.get(name, 0.0)+assignment.weight
        current=max(scores, key=scores.get) if scores else None
        target=None
        bucket=None
        if arm_dist<torso_dist*0.72 and arm_dist<max(0.004, arm_best[3]*0.85):
            target=arm_best[0]
            bucket='arm'
        elif current in HERO_ARM_BONES and torso_dist+0.0015<arm_dist:
            target=torso_best[0]
            bucket='torso'
        if target is None or target==current:
            continue
        for index in component:
            for assignment in list(mesh.data.vertices[index].groups):
                group=mesh.vertex_groups[assignment.group]
                if group.name in deform_names:
                    group.remove([index])
            groups[target].add([index], 1.0, 'REPLACE')
        if bucket=='arm':
            to_arm+=len(component)
        else:
            to_torso+=len(component)
    print('HERO_ARM_BIND', 'to_arm', to_arm, 'to_torso', to_torso)
    if to_arm<200:
        raise RuntimeError(f'Arm bones received only {to_arm} sleeve vertices')
    if to_torso<400:
        raise RuntimeError(f'Coat stayed on the arm bones ({to_torso} vertices moved back to the torso)')
    mesh.data.update()


def _euler_on(axis, angle):
    euler=[0.0, 0.0, 0.0]
    euler[axis]=angle
    return tuple(euler)


def _arm_forward_hinge(arm, side):
    bone=f'mixamorig:{side}Arm'
    hand=f'mixamorig:{side}Hand'
    pose_reset(arm)
    bpy.context.view_layer.update()
    rest=(arm.matrix_world@arm.pose.bones[hand].head).copy()
    forward=Vector((0.0, -1.0, 0.0))
    best=None
    for axis in range(3):
        for sign in (1.0, -1.0):
            pose_reset(arm)
            arm.pose.bones[bone].rotation_euler=_euler_on(axis, sign*0.8)
            bpy.context.view_layer.update()
            delta=(arm.matrix_world@arm.pose.bones[hand].head)-rest
            score=delta.dot(forward)
            if best is None or score>best[0]:
                best=(score, axis, sign, delta.copy())
    pose_reset(arm)
    bpy.context.view_layer.update()
    if best[0]<0.003:
        raise RuntimeError(f'{side} arm has no forward hinge, best delta {[round(float(v),4) for v in best[3]]}')
    print('HERO_HINGE', side, 'axis', 'XYZ'[best[1]], 'sign', int(best[2]), 'hand_delta', [round(float(v),4) for v in best[3]])
    return best[1], best[2]


def _elbow_hinge(arm, side):
    upper=f'mixamorig:{side}Arm'
    fore=f'mixamorig:{side}ForeArm'
    hand=f'mixamorig:{side}Hand'
    pose_reset(arm)
    bpy.context.view_layer.update()
    shoulder=(arm.matrix_world@arm.pose.bones[upper].head).copy()
    rest_dist=((arm.matrix_world@arm.pose.bones[hand].head)-shoulder).length
    best=None
    for axis in range(3):
        for sign in (1.0, -1.0):
            pose_reset(arm)
            arm.pose.bones[fore].rotation_euler=_euler_on(axis, sign*0.7)
            bpy.context.view_layer.update()
            posed=arm.matrix_world@arm.pose.bones[hand].head
            flex=rest_dist-(posed-shoulder).length
            if best is None or flex>best[0]:
                best=(flex, axis, sign)
    pose_reset(arm)
    bpy.context.view_layer.update()
    if best[0]<0.0015:
        print('HERO_ELBOW', side, 'none')
        return None
    print('HERO_ELBOW', side, 'axis', 'XYZ'[best[1]], 'sign', int(best[2]), 'flex', round(best[0], 4))
    return best[1], best[2]


def _arm_channels(side, hinge, elbow, amount):
    axis, sign=hinge
    channels={
        f'mixamorig:{side}Shoulder':{'rot':_euler_on(axis, sign*amount*0.28)},
        f'mixamorig:{side}Arm':{'rot':_euler_on(axis, sign*amount)},
    }
    if elbow is not None:
        bend=0.22+0.38*max(amount, 0.0)/0.7
        channels[f'mixamorig:{side}ForeArm']={'rot':_euler_on(elbow[0], elbow[1]*bend)}
    return channels


def _merge_channels(frame, extra):
    for bone, channels in extra.items():
        frame.setdefault(bone, {}).update(channels)


def assert_hero_arm_swing(mesh, arm, hinges, elbows):
    pose_reset(arm)
    bpy.context.view_layer.update()
    rest=evaluated_vertex_positions(mesh)
    for side, amount in (('Left', -0.7), ('Right', 0.7)):
        axis, sign=hinges[side]
        arm.pose.bones[f'mixamorig:{side}Shoulder'].rotation_euler=_euler_on(axis, sign*amount*0.28)
        arm.pose.bones[f'mixamorig:{side}Arm'].rotation_euler=_euler_on(axis, sign*amount)
        elbow=elbows[side]
        if elbow is not None:
            arm.pose.bones[f'mixamorig:{side}ForeArm'].rotation_euler=_euler_on(elbow[0], elbow[1]*(0.22+0.38))
    bpy.context.view_layer.update()
    posed=evaluated_vertex_positions(mesh)
    owners=[]
    for vertex in mesh.data.vertices:
        best=None
        weight=-1.0
        for assignment in vertex.groups:
            if assignment.weight>weight:
                weight=assignment.weight
                best=mesh.vertex_groups[assignment.group].name
        owners.append(best)
    def mean(names):
        indices=[index for index, owner in enumerate(owners) if owner in names]
        if len(indices)<30:
            raise RuntimeError(f'Arm bind missing targets for {names}')
        return sum((posed[index]-rest[index]).length for index in indices)/len(indices), len(indices)
    left, left_n=mean(('mixamorig:LeftShoulder','mixamorig:LeftArm','mixamorig:LeftForeArm','mixamorig:LeftHand'))
    hips, hips_n=mean(('mixamorig:Hips',))
    print('HERO_ARM_SWING', 'left_mean', round(left, 4), 'verts', left_n, 'hips_mean', round(hips, 4), 'verts', hips_n)
    if left<0.004:
        raise RuntimeError(f'Bound left arm barely moves ({left:.4f})')
    if hips>left*0.45:
        raise RuntimeError(f'Coat is still skinned to the arm swing (hips {hips:.4f} vs arm {left:.4f})')
    pose_reset(arm)
    bpy.context.view_layer.update()


def hero_actions(arm, mesh):
    L='mixamorig:Left'; R='mixamorig:Right'
    hinges={'Left':_arm_forward_hinge(arm, 'Left'), 'Right':_arm_forward_hinge(arm, 'Right')}
    elbows={'Left':_elbow_hinge(arm, 'Left'), 'Right':_elbow_hinge(arm, 'Right')}
    assert_hero_arm_swing(mesh, arm, hinges, elbows)
    swing=0.7
    # Left leg +X is the forward step in this rig, so the left arm swings back on frame 1.
    arm_phase={1:-swing, 7:0.0, 13:swing, 19:0.0, 24:-swing}
    make_action(arm,'Idle',[1,12,24],{
        1:{'mixamorig:Spine2':{'rot':(0,0,0)}},12:{'mixamorig:Spine2':{'rot':(0.04,0,0.02)},'mixamorig:Head':{'rot':(-0.02,0,0)}},24:{'mixamorig:Spine2':{'rot':(0,0,0)}}})
    world_locomotion={
        'MoveForward':(0,-0.010,0),'MoveBackward':(0,0.008,0),
        'StrafeLeft':(0.008,0,0),'StrafeRight':(-0.008,0,0)}
    for name,world_delta in world_locomotion.items():
        delta=local_location_for_world_delta(arm,'GameRoot',world_delta)
        keys={
            1:{'GameRoot':{'loc':(0,0,0)},f'{L}UpLeg':{'rot':(0.35,0,0)},f'{R}UpLeg':{'rot':(-0.35,0,0)}},
            7:{f'{L}Leg':{'rot':(0.5,0,0)},f'{R}Leg':{'rot':(0.05,0,0)}},
            13:{'GameRoot':{'loc':delta},f'{L}UpLeg':{'rot':(-0.35,0,0)},f'{R}UpLeg':{'rot':(0.35,0,0)}},
            19:{f'{L}Leg':{'rot':(0.05,0,0)},f'{R}Leg':{'rot':(0.5,0,0)}},
            24:{'GameRoot':{'loc':tuple(value*2 for value in delta)},f'{L}UpLeg':{'rot':(0.35,0,0)},f'{R}UpLeg':{'rot':(-0.35,0,0)}},
        }
        for frame, amount in arm_phase.items():
            _merge_channels(keys[frame], _arm_channels('Left', hinges['Left'], elbows['Left'], amount))
            _merge_channels(keys[frame], _arm_channels('Right', hinges['Right'], elbows['Right'], -amount))
        make_action(arm,name,[1,7,13,19,24],keys,'LowerBody')
    make_action(arm,'Shoot',[1,5,9,16],{
        1:{'mixamorig:Spine2':{'rot':(0,0,0)}},
        5:{'mixamorig:Spine2':{'rot':(-0.15,0,0.08)},f'{R}Arm':{'rot':(-0.35,0.15,-0.15)},f'{R}ForeArm':{'rot':(-0.45,0,0)},f'{L}Arm':{'rot':(-0.2,-0.1,0.1)}},
        9:{'mixamorig:Spine2':{'rot':(0.10,0,-0.04)},f'{R}ForeArm':{'rot':(-0.18,0,0)}},
        16:{'mixamorig:Spine2':{'rot':(0,0,0)}}},'UpperBody')
    make_action(arm,'Hit',[1,5,12],{1:{'mixamorig:Spine':{'rot':(0,0,0)}},5:{'mixamorig:Spine':{'rot':(0.25,0,0.18)},'mixamorig:Head':{'rot':(0.1,0,-0.25)}},12:{'mixamorig:Spine':{'rot':(0,0,0)}}})
    make_action(arm,'Death',[1,12,28],{1:{'GameRoot':{'rot':(0,0,0)}},12:{'GameRoot':{'rot':(0.2,0,0.5)},'mixamorig:Spine':{'rot':(0.4,0,0.3)}},28:{'GameRoot':{'rot':(0.15,0,1.35),'loc':(0,0,-0.025)},'mixamorig:Spine':{'rot':(0.6,0,0.2)}}})


def slime_actions(arm):
    make_action(arm,'IdleSquash',[1,12,24],{1:{'SlimeCore':{'scale':(1,1,1)}},12:{'SlimeCore':{'scale':(1.08,0.88,1.08)}},24:{'SlimeCore':{'scale':(1,1,1)}}})
    hop_world={1:(0,0,0),6:(0,-0.025,0.055),12:(0,-0.055,0.015),18:(0,-0.08,0.05),24:(0,0,0)}
    hop_local={frame:local_location_for_world_delta(arm,'SlimeRoot',delta) for frame,delta in hop_world.items()}
    make_action(arm,'HopMove',[1,6,12,18,24],{1:{'SlimeRoot':{'loc':hop_local[1]},'SlimeCore':{'scale':(1.12,0.78,1.12)}},6:{'SlimeRoot':{'loc':hop_local[6]},'SlimeCore':{'scale':(0.88,1.22,0.88)}},12:{'SlimeRoot':{'loc':hop_local[12]},'SlimeCore':{'scale':(1.03,0.92,1.03)}},18:{'SlimeRoot':{'loc':hop_local[18]},'SlimeCore':{'scale':(0.92,1.15,0.92)}},24:{'SlimeRoot':{'loc':hop_local[24]},'SlimeCore':{'scale':(1,1,1)}}})
    make_action(arm,'Attack',[1,7,12,20],{1:{'SlimeCore':{'rot':(0,0,0)}},7:{'SlimeCore':{'rot':(-0.45,0,0),'scale':(0.92,1.18,0.92)}},12:{'SlimeCore':{'rot':(0.6,0,0),'scale':(0.85,1.28,0.85)}},20:{'SlimeCore':{'rot':(0,0,0),'scale':(1,1,1)}}})
    make_action(arm,'Hit',[1,4,12],{1:{'SlimeCore':{'rot':(0,0,0)}},4:{'SlimeCore':{'rot':(0,0.48,0),'scale':(1.15,0.82,0.88)}},12:{'SlimeCore':{'rot':(0,0,0),'scale':(1,1,1)}}})
    make_action(arm,'Death',[1,12,28],{1:{'SlimeCore':{'scale':(1,1,1)}},12:{'SlimeCore':{'scale':(1.35,0.52,1.35)}},28:{'SlimeCore':{'scale':(1.65,0.20,1.65)}}})


def hound_actions(arm):
    make_action(arm,'Idle',[1,12,24],{1:{'Spine':{'rot':(0,0,0)}},12:{'Spine':{'rot':(0.03,0,0)},'Tail.01':{'rot':(0,0,0.18)},'Head':{'rot':(-0.05,0,0)}},24:{'Spine':{'rot':(0,0,0)},'Tail.01':{'rot':(0,0,-0.18)}}})
    make_action(arm,'Walk',[1,7,13,19,25],{
        1:{'FrontUpper.L':{'rot':(0.20,0,0)},'BackUpper.R':{'rot':(0.20,0,0)},'FrontUpper.R':{'rot':(-0.20,0,0)},'BackUpper.L':{'rot':(-0.20,0,0)}},
        7:{'FrontLower.R':{'rot':(-0.28,0,0)},'BackLower.L':{'rot':(-0.28,0,0)},'Root':{'loc':(0,0,0.015)}},
        13:{'FrontUpper.L':{'rot':(-0.20,0,0)},'BackUpper.R':{'rot':(-0.20,0,0)},'FrontUpper.R':{'rot':(0.20,0,0)},'BackUpper.L':{'rot':(0.20,0,0)}},
        19:{'FrontLower.L':{'rot':(-0.28,0,0)},'BackLower.R':{'rot':(-0.28,0,0)},'Root':{'loc':(0,0,0.015)}},
        25:{'FrontUpper.L':{'rot':(0.20,0,0)},'BackUpper.R':{'rot':(0.20,0,0)},'FrontUpper.R':{'rot':(-0.20,0,0)},'BackUpper.L':{'rot':(-0.20,0,0)}}})
    make_action(arm,'Run',[1,6,12,18,25],{
        1:{'FrontUpper.L':{'rot':(-0.30,0,0)},'FrontUpper.R':{'rot':(-0.30,0,0)},'BackUpper.L':{'rot':(0.32,0,0)},'BackUpper.R':{'rot':(0.32,0,0)}},
        6:{'FrontLower.L':{'rot':(-0.42,0,0)},'FrontLower.R':{'rot':(-0.42,0,0)},'BackLower.L':{'rot':(-0.50,0,0)},'BackLower.R':{'rot':(-0.50,0,0)},'Root':{'loc':(0,0,0.055)}},
        12:{'FrontUpper.L':{'rot':(0.20,0,0)},'FrontUpper.R':{'rot':(0.20,0,0)},'BackUpper.L':{'rot':(-0.20,0,0)},'BackUpper.R':{'rot':(-0.20,0,0)},'Root':{'loc':(0,0,0.09)}},
        18:{'FrontUpper.L':{'rot':(0.34,0,0)},'FrontUpper.R':{'rot':(0.34,0,0)},'BackUpper.L':{'rot':(-0.34,0,0)},'BackUpper.R':{'rot':(-0.34,0,0)},'Root':{'loc':(0,0,0.025)}},
        25:{'FrontUpper.L':{'rot':(-0.30,0,0)},'FrontUpper.R':{'rot':(-0.30,0,0)},'BackUpper.L':{'rot':(0.32,0,0)},'BackUpper.R':{'rot':(0.32,0,0)}}})
    make_action(arm,'Attack',[1,7,12,20],{1:{'Neck':{'rot':(0,0,0)}},7:{'Neck':{'rot':(-0.45,0,0)},'Head':{'rot':(0.25,0,0)}},12:{'Root':{'loc':(0,-0.18,0.04)},'Neck':{'rot':(0.6,0,0)},'Head':{'rot':(-0.35,0,0)}},20:{'Neck':{'rot':(0,0,0)}}})
    make_action(arm,'Hit',[1,5,14],{1:{'Spine':{'rot':(0,0,0)}},5:{'Spine':{'rot':(0,0,0.35)},'Head':{'rot':(0,0,-0.25)}},14:{'Spine':{'rot':(0,0,0)}}})
    make_action(arm,'Death',[1,14,32],{1:{'Root':{'rot':(0,0,0)}},14:{'Root':{'rot':(0,0,0.65)},'Spine':{'rot':(0.25,0,0.2)}},32:{'Root':{'rot':(0,0,1.45),'loc':(0,0,-0.18)},'Spine':{'rot':(0.5,0,0.15)}}})


CAPE_NAMES=['Cape.01','Cape.02','Cape.03','Cape.04']


def _component_records(mesh):
    mn,mx=bounds(mesh)
    center=(mn+mx)*0.5
    width=max(mx.x-mn.x,1e-8); depth=max(mx.y-mn.y,1e-8); height=max(mx.z-mn.z,1e-8)
    infos=[]
    for component in connected_components(mesh):
        points=[mesh.matrix_world@mesh.data.vertices[index].co for index in component]
        low=Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
        high=Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
        infos.append({'indices':component,'center':sum(points,Vector())/len(points),'min':low,'max':high,'extent':high-low})
    return infos,mn,mx,center,width,depth,height


def analyze_knight(mesh):
    infos,mn,mx,center,width,depth,height=_component_records(mesh)
    for info in infos:
        extent=info['extent']; point=info['center']
        thin=extent.z>max(extent.x,extent.y)*2.2 and extent.z>0.18*height and extent.x<0.16*width and extent.y<0.22*depth
        right_front=point.x<center.x-0.18*width and point.y<center.y-0.12*depth
        info['sword']=bool(thin and right_front)
    cores=[info for info in infos if info['sword']]
    if not cores:
        raise RuntimeError('No knight sword core islands found')
    pad=Vector((0.045,0.045,0.04))
    sword_min=Vector(tuple(min(info['min'][axis] for info in cores) for axis in range(3)))-pad
    sword_max=Vector(tuple(max(info['max'][axis] for info in cores) for axis in range(3)))+pad
    for info in infos:
        if info['sword']:
            continue
        point=info['center']; extent=info['extent']
        inside=all(sword_min[axis]<=point[axis]<=sword_max[axis] for axis in range(3))
        slim=max(extent.x,extent.y)<0.14*max(width,depth) and extent.x<0.20*width and len(info['indices'])<200
        info['sword']=bool(inside and slim)
    sword_indices=[index for info in infos if info['sword'] for index in info['indices']]
    sword_points=[mesh.matrix_world@mesh.data.vertices[index].co for index in sword_indices]
    z_values=sorted(point.z for point in sword_points)
    def percentile(sorted_values, fraction):
        return sorted_values[min(len(sorted_values)-1, max(0, int(round(fraction*(len(sorted_values)-1)))))]
    def cluster(limit, above):
        chosen=[point for point in sword_points if point.z>=limit] if above else [point for point in sword_points if point.z<=limit]
        if not chosen:
            chosen=sword_points
        return sum(chosen, Vector())/len(chosen)
    sword_head=cluster(percentile(z_values,0.86), True)
    sword_tail=cluster(percentile(z_values,0.08), False)
    if sword_tail.z>sword_head.z:
        sword_head,sword_tail=sword_tail,sword_head
    cape_parts=[info for info in infos if not info['sword'] and info['center'].y>0.235 and info['min'].y>0.11 and info['center'].z<0.45 and info['max'].z<0.70]
    cape_indices=[index for info in cape_parts for index in info['indices']]
    if len(cape_indices)<400:
        raise RuntimeError(f'Knight cape region is too small ({len(cape_indices)} vertices)')
    cape_parts.sort(key=lambda info: -info['center'].z)
    bands=[[] for _ in CAPE_NAMES]
    seen=0
    band_index=0
    share=len(cape_indices)/len(CAPE_NAMES)
    for info in cape_parts:
        if band_index<len(CAPE_NAMES)-1 and seen>=share*(band_index+1) and bands[band_index]:
            band_index+=1
        bands[band_index].extend(info['indices'])
        seen+=len(info['indices'])
    # A full-length rear edge sits just outside the cape sheet test (its hem
    # leans forward and its top clears the shoulder). Keep it on Cape.02,
    # beside the cape islands it already touches, instead of the chest.
    edge_strips=[info for info in infos if not info['sword'] and info not in cape_parts
                 and info['center'].y>0.235 and info['min'].y>0.08 and info['center'].z<0.45
                 and info['max'].z<0.73 and info['extent'].z>1.2]
    bands[1].extend(index for info in edge_strips for index in info['indices'])
    cape_points=[]
    for band in bands:
        points=[mesh.matrix_world@mesh.data.vertices[index].co for index in band]
        cape_points.append(sum(points, Vector())/len(points))
    cape_points.append(cape_points[-1]+Vector((0.0,0.02,-max(0.12*height,0.08))))
    return {'sword_indices':sword_indices,'sword_head':sword_head,'sword_tail':sword_tail,'cape_bands':bands,'cape_points':cape_points}


def _replace_bone(specs, name, head=None, tail=None):
    found=False
    replaced=[]
    for spec in specs:
        if spec[0]!=name:
            replaced.append(spec)
            continue
        found=True
        _, old_head, old_tail, parent, deform=spec
        replaced.append(B(name, old_head if head is None else Vector(head), old_tail if tail is None else Vector(tail), parent, deform))
    if not found:
        raise RuntimeError(f'Missing bone spec {name}')
    return replaced


def fit_knight_accessories(mesh, specs):
    analysis=analyze_knight(mesh)
    grip=analysis['sword_head']; tip=analysis['sword_tail']
    blade=tip-grip
    if blade.length<0.2:
        raise RuntimeError('Knight sword endpoints are too close')
    direction=blade.normalized()
    shoulder=next(spec[1] for spec in specs if spec[0]=='UpperArm.R')
    elbow=shoulder*0.48+grip*0.52+Vector((-0.10,0.05,0.04))
    specs=_replace_bone(specs,'UpperArm.R', tail=elbow)
    specs=_replace_bone(specs,'Forearm.R', head=elbow, tail=grip)
    specs=_replace_bone(specs,'Hand.R', head=grip, tail=grip+direction*0.10)
    specs=_replace_bone(specs,'HandSocket.R', head=grip, tail=grip+Vector((0.0,-0.06,0.0)))
    specs=_replace_bone(specs,'WeaponSocket', head=grip, tail=grip+direction*0.06)
    specs=list(specs)
    specs.append(B('Sword', grip, tip, 'Hand.R', True))
    parent='Chest'
    points=analysis['cape_points']
    for index,name in enumerate(CAPE_NAMES):
        head=points[index]; tail=points[index+1]
        if (tail-head).length<1e-4:
            tail=head+Vector((0.0,0.02,-0.08))
        specs.append(B(name, head, tail, parent, True))
        parent=name
    print('KNIGHT_SWORD', [round(float(value),3) for value in grip], [round(float(value),3) for value in tip])
    return specs


def aim_bone_y(arm, bone_name, world_direction):
    pose_bone=arm.pose.bones[bone_name]
    pose_bone.rotation_mode='XYZ'
    pose_bone.location=(0.0,0.0,0.0)
    pose_bone.scale=(1.0,1.0,1.0)
    pose_bone.rotation_euler=(0.0,0.0,0.0)
    bpy.context.view_layer.update()
    target=Vector(world_direction)
    if target.length<1e-8:
        return (0.0,0.0,0.0)
    target_armature=(arm.matrix_world.to_3x3().inverted()@target).normalized()
    parent=pose_bone.parent
    if parent:
        local_rest=parent.bone.matrix_local.inverted()@pose_bone.bone.matrix_local
        parent_rotation=parent.matrix.to_3x3()
    else:
        local_rest=pose_bone.bone.matrix_local
        parent_rotation=Matrix.Identity(3)
    basis_y=(parent_rotation@local_rest.to_3x3()).inverted()@target_armature
    euler=(0.0,0.0,0.0) if basis_y.length<1e-8 else tuple(Vector((0.0,1.0,0.0)).rotation_difference(basis_y.normalized()).to_euler('XYZ'))
    pose_bone.rotation_euler=euler
    bpy.context.view_layer.update()
    actual_world=(arm.matrix_world.to_3x3()@(pose_bone.matrix.to_3x3()@Vector((0.0,1.0,0.0)))).normalized()
    if actual_world.dot(target.normalized())<0.95:
        raise RuntimeError(f'{bone_name} aim drifted, dot={actual_world.dot(target.normalized()):.3f}')
    return tuple(float(value) for value in pose_bone.rotation_euler)


def bone_world_length(arm, name):
    bone=arm.data.bones[name]
    return ((arm.matrix_world@bone.tail_local)-(arm.matrix_world@bone.head_local)).length


def solve_two_bone(arm, side, target, pole, blade_direction=None):
    upper=f'UpperArm.{side}'; forearm=f'Forearm.{side}'
    bpy.context.view_layer.update()
    shoulder=arm.matrix_world@arm.pose.bones[upper].head
    length_upper=bone_world_length(arm, upper); length_fore=bone_world_length(arm, forearm)
    target=Vector(target); delta=target-shoulder
    if delta.length<1e-8:
        delta=Vector((0.0,-1.0,0.0))
    distance=min(max(delta.length, abs(length_upper-length_fore)+1e-4), length_upper+length_fore-1e-4)
    axis=delta.normalized()
    cosine=max(-1.0, min(1.0, (length_upper*length_upper+distance*distance-length_fore*length_fore)/(2*length_upper*distance)))
    sine=math.sqrt(max(0.0, 1.0-cosine*cosine))
    pole_vector=Vector(pole)-shoulder
    pole_vector=pole_vector-axis*pole_vector.dot(axis)
    if pole_vector.length<1e-6:
        pole_vector=Vector((1.0,0.0,0.0))
    pole_vector.normalize()
    elbow=shoulder+axis*(length_upper*cosine)+pole_vector*(length_upper*sine)
    aim_bone_y(arm, upper, elbow-shoulder)
    elbow_posed=arm.matrix_world@arm.pose.bones[forearm].head
    aim_bone_y(arm, forearm, target-elbow_posed)
    if blade_direction is not None and side=='R' and 'Sword' in arm.pose.bones:
        aim_bone_y(arm, 'Sword', blade_direction)


def cape_hang(arm, lateral, droop, forward=None):
    if 'Cape.01' not in arm.pose.bones:
        return
    for index,name in enumerate(CAPE_NAMES):
        amount=(index+1)/len(CAPE_NAMES)
        # forward is a world-Y aim. Positive Y is behind the shoulders.
        # The default droop keeps the older slight forward hang.
        depth=(-0.05-droop*amount) if forward is None else forward*amount
        aim_bone_y(arm, name, Vector((lateral*amount, depth, -1.0)))


def apply_channels(arm, channels, skip_root=False):
    for bone_name, channels_for_bone in channels.items():
        if skip_root and bone_name=='Root':
            continue
        if bone_name not in arm.pose.bones:
            continue
        pose_bone=arm.pose.bones[bone_name]
        pose_bone.rotation_mode='XYZ'
        if 'loc' in channels_for_bone:
            pose_bone.location=channels_for_bone['loc']
        if 'rot' in channels_for_bone:
            pose_bone.rotation_euler=channels_for_bone['rot']
        if 'scale' in channels_for_bone:
            pose_bone.scale=channels_for_bone['scale']
    bpy.context.view_layer.update()


def capture_channels(arm, names):
    captured={}
    for name in names:
        if name not in arm.pose.bones:
            continue
        pose_bone=arm.pose.bones[name]
        pose_bone.rotation_mode='XYZ'
        rotation=tuple(round(float(value),5) for value in pose_bone.rotation_euler)
        location=tuple(round(float(value),5) for value in pose_bone.location)
        channels={}
        if any(abs(value)>1e-5 for value in rotation):
            channels['rot']=rotation
        if any(abs(value)>1e-5 for value in location):
            channels['loc']=location
        if channels:
            captured[name]=channels
    return captured


def with_cape(arm, keys, drape, inherit_root=True):
    if 'Cape.01' not in arm.pose.bones:
        return keys
    solved={}
    for frame,channels in keys.items():
        pose_reset(arm)
        apply_channels(arm, channels, skip_root=not inherit_root)
        lateral,droop=drape[frame]
        cape_hang(arm, lateral, droop)
        merged={bone:dict(values) for bone,values in channels.items()}
        for name in CAPE_NAMES:
            merged[name]={'rot':tuple(round(float(value),5) for value in arm.pose.bones[name].rotation_euler)}
        solved[frame]=merged
    pose_reset(arm)
    bpy.context.view_layer.update()
    return solved


def evaluated_vertex_positions(mesh):
    deps=bpy.context.evaluated_depsgraph_get()
    evaluated=mesh.evaluated_get(deps)
    data=evaluated.to_mesh()
    try:
        return [evaluated.matrix_world@vertex.co for vertex in data.vertices]
    finally:
        evaluated.to_mesh_clear()


def group_indices(mesh, names, threshold=0.5):
    wanted=set()
    for name in names:
        group=mesh.vertex_groups.get(name)
        if group is None:
            continue
        for vertex in mesh.data.vertices:
            for assignment in vertex.groups:
                if assignment.group==group.index and assignment.weight>threshold:
                    wanted.add(vertex.index)
                    break
    return wanted


def sword_cape_clearance(mesh, sword_indices, cape_indices):
    deps=bpy.context.evaluated_depsgraph_get()
    evaluated=mesh.evaluated_get(deps)
    points=[evaluated.matrix_world@vertex.co for vertex in evaluated.data.vertices]
    tree=KDTree(len(cape_indices))
    for slot,index in enumerate(cape_indices):
        tree.insert(points[index], slot)
    tree.balance()
    gap=min(tree.find(points[index])[2] for index in sword_indices)
    sword_max_y=max(points[index].y for index in sword_indices)
    return gap, sword_max_y


def roll_sword_clear(arm, mesh, sword_indices, cape_indices, previous_euler):
    """Spin the blade around its length so the crossguard stays off the cape.

    Prefer a roll close to the previous frame. An independent best-gap search
    flips the guard between frames, and Euler interpolation then drags the blade
    back through the cape.
    """
    sword=arm.pose.bones['Sword']
    sword.rotation_mode='XYZ'
    base=sword.rotation_euler.to_quaternion()
    best=None
    for step in range(36):
        angle=step*math.tau/36
        sword.rotation_euler=(base@Quaternion(Vector((0.0,1.0,0.0)), angle)).to_euler('XYZ')
        bpy.context.view_layer.update()
        gap,sword_max_y=sword_cape_clearance(mesh, sword_indices, cape_indices)
        quat=sword.rotation_euler.to_quaternion()
        clear=gap>=0.04 and sword_max_y<0.0
        if previous_euler is None:
            continuity=1.0
        else:
            continuity=abs(quat.dot(previous_euler.to_quaternion()))
        score=(1 if clear else 0, continuity, gap)
        if best is None or score>best[0]:
            best=(score, quat, gap, sword_max_y)
    chosen=best[1]
    sword.rotation_euler=chosen.to_euler('XYZ', previous_euler) if previous_euler is not None else chosen.to_euler('XYZ')
    bpy.context.view_layer.update()
    return best[2], best[3], sword.rotation_euler.copy()


def compatible_eulers(arm, names, previous):
    for name in names:
        pose_bone=arm.pose.bones[name]
        pose_bone.rotation_mode='XYZ'
        quat=pose_bone.rotation_euler.to_quaternion()
        pose_bone.rotation_euler=quat.to_euler('XYZ', previous[name]) if name in previous else quat.to_euler('XYZ')
        previous[name]=pose_bone.rotation_euler.copy()
    bpy.context.view_layer.update()


def knight_sweep_pose(frame):
    """Frame 8 chambers on the right, frame 16 is the leftward cut, frame 24 follows through."""
    if frame in (1, 32):
        return {'twist':0.0,'aim':False,'lateral':0.0,'forward':0.20}
    span=frame-8
    t=span/16.0
    if t<=0.5:
        blend=t/0.5
        blend=blend*blend*(3.0-2.0*blend)
        angle=math.radians(-70.0+blend*135.0)
        drop=0.16*(1.0-blend)
        offset=Vector((-0.20,-0.40,0.08)).lerp(Vector((0.04,-0.48,-0.02)), blend)
        twist=0.08+( -0.02-0.08)*blend
        lateral=-0.04+(0.04-(-0.04))*blend
    else:
        blend=(t-0.5)/0.5
        angle=math.radians(65.0+blend*12.0)
        drop=-0.30*blend
        offset=Vector((0.04,-0.48,-0.02)).lerp(Vector((0.08,-0.40,-0.08)), blend)
        twist=-0.02+(-0.08-(-0.02))*blend
        lateral=0.04+(0.06-0.04)*blend
    return {
        'twist':twist,'aim':True,'offset':offset,
        'blade':Vector((math.sin(angle), -math.cos(angle), drop)),
        'lateral':lateral,'forward':0.23,
    }


def knight_attack_keys(arm, mesh):
    """Horizontal right-to-left slash. Every swing frame is keyed so Euler interpolation cannot pass behind the cape."""
    sword_indices=group_indices(mesh, ['Sword'])
    cape_indices=group_indices(mesh, CAPE_NAMES)
    if len(sword_indices)<40 or len(cape_indices)<400:
        raise RuntimeError('Knight attack is missing sword or cape weights')
    frames=[1,*range(8,25),32]
    keys={}; names=['Chest','UpperArm.R','Forearm.R','Hand.R','Sword',*CAPE_NAMES]
    previous={}; previous_sword=None
    for frame in frames:
        pose=knight_sweep_pose(frame)
        pose_reset(arm)
        arm.pose.bones['Chest'].rotation_mode='XYZ'
        arm.pose.bones['Chest'].rotation_euler=(0.0,0.0,pose['twist'])
        bpy.context.view_layer.update()
        if pose['aim']:
            shoulder=arm.matrix_world@arm.pose.bones['UpperArm.R'].head
            solve_two_bone(arm,'R', shoulder+pose['offset'], shoulder+Vector((-0.35,-0.25,0.10)), pose['blade'])
        cape_hang(arm, pose['lateral'], 0.0, forward=pose['forward'])
        if pose['aim']:
            gap,sword_max_y,_=roll_sword_clear(arm, mesh, sword_indices, cape_indices, previous_sword)
        else:
            gap,sword_max_y=sword_cape_clearance(mesh, sword_indices, cape_indices)
        compatible_eulers(arm, names, previous)
        if pose['aim']:
            previous_sword=arm.pose.bones['Sword'].rotation_euler.copy()
        keys[frame]=capture_channels(arm, names)
        sword=arm.pose.bones['Sword']
        head=arm.matrix_world@sword.head
        tail=arm.matrix_world@sword.tail
        direction=(tail-head).normalized()
        print('KNIGHT_ATTACK', frame, [round(float(value),3) for value in direction],
              'grip', [round(float(value),3) for value in head], 'tip', [round(float(value),3) for value in tail],
              'gap', round(gap,3), 'sword_max_y', round(sword_max_y,3))
        if not pose['aim']:
            continue
        forward_limit=-0.28 if frame<=16 else -0.18
        if direction.y>forward_limit or abs(direction.z)>0.45 or head.y>-0.20:
            raise RuntimeError(f'Knight sweep is not a front-facing horizontal cut at frame {frame}')
        if frame==16 and (direction.x<0.45 or abs(direction.z)>0.2):
            raise RuntimeError('Knight frame 16 is not the leftward horizontal slash')
        if gap<0.12 or sword_max_y>0.0:
            raise RuntimeError(f'Knight sword intersects the cape at frame {frame}: gap={gap:.3f} max_y={sword_max_y:.3f}')
    pose_reset(arm)
    bpy.context.view_layer.update()
    return keys


def linearize_action(action):
    curves=[]
    try:
        curves=list(action.fcurves)
    except Exception:
        for layer in action.layers:
            for strip in layer.strips:
                for slot in action.slots:
                    bag=strip.channelbag(slot)
                    if bag:
                        curves.extend(bag.fcurves)
    for curve in curves:
        for point in curve.keyframe_points:
            point.interpolation='LINEAR'


def assert_knight_attack_playback(arm, mesh):
    """Sample the baked curves. Key poses can be clear while in-betweens swing through the cape."""
    sword_indices=group_indices(mesh, ['Sword'])
    cape_indices=group_indices(mesh, CAPE_NAMES)
    action=bpy.data.actions['Attack']
    linearize_action(action)
    assign_action(arm, action)
    try:
        for frame in range(1, 33):
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            sword=arm.pose.bones['Sword']
            head=arm.matrix_world@sword.head
            tail=arm.matrix_world@sword.tail
            direction=(tail-head).normalized()
            gap,sword_max_y=sword_cape_clearance(mesh, sword_indices, cape_indices)
            print('KNIGHT_PLAY', frame, [round(float(value),3) for value in direction], 'gap', round(gap,3), 'max_y', round(sword_max_y,3))
            if gap<0.08:
                raise RuntimeError(f'Knight attack playback clips the cape at frame {frame}: gap={gap:.3f}')
            forward_limit=-0.25 if frame<=16 else -0.15
            if 8<=frame<=24 and (direction.y>forward_limit or gap<0.15 or sword_max_y>-0.05):
                raise RuntimeError(f'Knight attack playback leaves the front slash at frame {frame}')
        bpy.context.scene.frame_set(1)
        bpy.context.view_layer.update()
        rest=evaluated_vertex_positions(mesh)
        sword_ids=list(group_indices(mesh, ['Sword']))
        tree=KDTree(len(sword_ids))
        for slot,index in enumerate(sword_ids):
            tree.insert(rest[index], slot)
        tree.balance()
        bpy.context.scene.frame_set(16)
        bpy.context.view_layer.update()
        posed=evaluated_vertex_positions(mesh)
        stuck=[index for index in range(len(rest)) if tree.find(rest[index])[2]<=0.012 and (posed[index]-rest[index]).length<0.15]
        print('SWORD_STUCK', len(stuck), 'of', len(sword_ids))
        owners={}
        for index in stuck:
            best=None
            weight=-1.0
            for assignment in mesh.data.vertices[index].groups:
                if assignment.weight>weight:
                    weight=assignment.weight
                    best=mesh.vertex_groups[assignment.group].name
            owners[best]=owners.get(best, 0)+1
        print('SWORD_STUCK_OWNERS', owners)
        if len(stuck)>20:
            raise RuntimeError(f'Idle sword shell still occupies the rest blade at frame 16 ({len(stuck)} vertices, {owners})')
    finally:
        arm.animation_data.action=None
        pose_reset(arm)
        bpy.context.scene.frame_set(1)
        bpy.context.view_layer.update()


def set_world_translation(arm, bone_name, world_delta):
    pose_bone=arm.pose.bones[bone_name]
    pose_bone.rotation_mode='XYZ'
    pose_bone.location=(0.0,0.0,0.0)
    bpy.context.view_layer.update()
    before=arm.matrix_world@pose_bone.head
    arm_delta=arm.matrix_world.to_3x3().inverted()@Vector(world_delta)
    candidates=[]
    if pose_bone.parent:
        candidates.append(pose_bone.parent.bone.matrix_local.to_3x3().inverted()@arm_delta)
    candidates.append(pose_bone.bone.matrix_local.to_3x3().inverted()@arm_delta)
    desired=Vector(world_delta)
    best=None
    for local in candidates:
        pose_bone.location=local
        bpy.context.view_layer.update()
        moved=(arm.matrix_world@pose_bone.head)-before
        score=moved.dot(desired.normalized()) if desired.length else -1.0
        best=(score, tuple(float(value) for value in pose_bone.location), moved) if best is None or score>best[0] else best
    if best[0]<desired.length*0.8:
        raise RuntimeError(f'{bone_name} translation landed {[round(float(v),3) for v in best[2]]}')
    pose_bone.location=best[1]
    bpy.context.view_layer.update()
    return best[1]


def ogre_belly_keys(arm):
    """Belly charge. A fist pound tears the continuous arm skin, so the belly translates rigidly forward."""
    poses={
        1:Vector((0.0,0.0,0.0)),
        8:Vector((0.0,0.10,0.04)),
        14:Vector((0.0,-0.28,-0.02)),
        20:Vector((0.0,-0.16,0.0)),
        30:Vector((0.0,0.0,0.0)),
    }
    keys={}
    for frame,delta in poses.items():
        pose_reset(arm)
        if delta.length>1e-6:
            aim_bone_y(arm,'Spine', Vector((0.0,-0.12 if frame==14 else -0.05, 1.0)))
            set_world_translation(arm,'Belly', delta)
        keys[frame]=capture_channels(arm, ['Spine','Belly'])
        head=arm.matrix_world@arm.pose.bones['Belly'].head
        print('OGRE_BELLY', frame, [round(float(value),3) for value in head])
    pose_reset(arm)
    bpy.context.view_layer.update()
    return keys


def humanoid_actions(arm, knight=False, mesh=None):
    idle='Idle' if knight else 'IdleHeavy'; walk='Walk' if knight else 'WalkHeavy'; attack='Attack' if knight else 'AttackPrimary'
    idle_keys={1:{'Chest':{'rot':(0,0,0)}},14:{'Chest':{'rot':(0.045,0,0.025)},'Head':{'rot':(-0.025,0,0)}},28:{'Chest':{'rot':(0,0,0)}}}
    if knight:
        idle_keys=with_cape(arm, idle_keys, {1:(0.0,0.18),14:(0.14,0.22),28:(0.0,0.18)})
    make_action(arm,idle,[1,14,28],idle_keys)
    amp=0.36 if knight else 0.28; dist=0.75 if knight else 0.55
    half_step=local_location_for_world_delta(arm,'Root',(0,-dist,0))
    full_step=local_location_for_world_delta(arm,'Root',(0,-dist*2,0))
    walk_keys={
        1:{'Root':{'loc':(0,0,0)},'Thigh.L':{'rot':(amp,0,0)},'Thigh.R':{'rot':(-amp,0,0)}},
        8:{'Shin.L':{'rot':(0.45,0,0)},'Chest':{'rot':(0,0,-0.05)}},
        15:{'Root':{'loc':half_step},'Thigh.L':{'rot':(-amp,0,0)},'Thigh.R':{'rot':(amp,0,0)}},
        22:{'Shin.R':{'rot':(0.45,0,0)},'Chest':{'rot':(0,0,0.05)}},
        29:{'Root':{'loc':full_step},'Thigh.L':{'rot':(amp,0,0)},'Thigh.R':{'rot':(-amp,0,0)}},
    }
    if knight:
        walk_keys=with_cape(arm, walk_keys, {1:(0.0,0.18),8:(-0.34,0.24),15:(0.0,0.18),22:(0.34,0.24),29:(0.0,0.18)})
    make_action(arm,walk,[1,8,15,22,29],walk_keys)
    if knight:
        attack_keys=knight_attack_keys(arm, mesh)
        make_action(arm,attack,sorted(attack_keys),attack_keys)
        assert_knight_attack_playback(arm, mesh)
        block_keys={1:{'UpperArm.L':{'rot':(0,0,0)}},8:{'UpperArm.L':{'rot':(-0.65,-0.25,0.5)},'Forearm.L':{'rot':(-0.8,0,0)},'Chest':{'rot':(0,0,-0.12)}},20:{'UpperArm.L':{'rot':(-0.55,-0.2,0.45)},'Forearm.L':{'rot':(-0.7,0,0)}}}
        make_action(arm,'Block',[1,8,20],with_cape(arm, block_keys, {1:(0.0,0.16),8:(-0.10,0.14),20:(-0.08,0.14)}),'UpperBody')
        hit_keys={1:{'Chest':{'rot':(0,0,0)}},6:{'Chest':{'rot':(0.25,0,0.25)},'Head':{'rot':(0.12,0,-0.3)}},16:{'Chest':{'rot':(0,0,0)}}}
        make_action(arm,'Hit',[1,6,16],with_cape(arm, hit_keys, {1:(0.0,0.18),6:(0.40,0.24),16:(0.0,0.18)}))
        death_keys={1:{'Root':{'rot':(0,0,0)}},16:{'Root':{'rot':(0.15,0,0.55)},'Spine':{'rot':(0.4,0,0.2)}},36:{'Root':{'rot':(0.10,0,1.45),'loc':(0,0,-0.3)},'Spine':{'rot':(0.65,0,0.2)}}}
        make_action(arm,'Death',[1,16,36],with_cape(arm, death_keys, {1:(0.0,0.18),16:(0.16,0.26),36:(0.0,0.30)}, inherit_root=False))
    else:
        make_action(arm,attack,[1,8,14,20,30],ogre_belly_keys(arm))
        make_action(arm,'Hit',[1,6,16],{1:{'Root':{'rot':(0,0,0)}},6:{'Root':{'rot':(0.14,0,0.22)}},16:{'Root':{'rot':(0,0,0)}}})
        make_action(arm,'Death',[1,16,36],{1:{'Root':{'rot':(0,0,0)}},16:{'Root':{'rot':(0.15,0,0.55)}},36:{'Root':{'rot':(0.10,0,1.45),'loc':(0,0,-0.3)}}})


def chest_actions(arm):
    make_action(arm,'Open',[1,8,20,30],{1:{'ChestLid':{'rot':(0,0,0)}},8:{'ChestLid':{'rot':(0,-0.35,0)}},20:{'ChestLid':{'rot':(0,-1.75,0)}},30:{'ChestLid':{'rot':(0,-1.55,0)}}})
    make_action(arm,'Close',[1,12,24],{1:{'ChestLid':{'rot':(0,-1.55,0)}},12:{'ChestLid':{'rot':(0,-0.5,0)}},24:{'ChestLid':{'rot':(0,0,0)}}})


def export_glb(asset, mesh, arm):
    swaps=[]; runtime_images=[]
    for slot in mesh.material_slots:
        material=slot.material
        if not material or not material.use_nodes:
            continue
        for node in material.node_tree.nodes:
            if node.type!='TEX_IMAGE' or not node.image:
                continue
            original=node.image; runtime=original.copy(); runtime.name=f'{original.name}_Runtime512'
            if max(runtime.size)>512:
                scale=512/max(runtime.size)
                runtime.scale(max(1,round(runtime.size[0]*scale)),max(1,round(runtime.size[1]*scale)))
            node.image=runtime; swaps.append((node,original)); runtime_images.append(runtime)
    try:
        bpy.ops.object.select_all(action='DESELECT')
        mesh.select_set(True); arm.select_set(True)
        bpy.context.view_layer.objects.active=arm
        path=OUT/f'{asset}_rigged_v1.glb'
        bpy.ops.export_scene.gltf(
            filepath=str(path), export_format='GLB', use_selection=True,
            export_animations=True, export_skins=True, export_morph=True,
            export_materials='EXPORT', export_yup=True,
            export_animation_mode='ACTIONS', export_armature_object_remove=False,
            export_image_format='JPEG', export_jpeg_quality=82,
            export_draco_mesh_compression_enable=True,
            export_draco_mesh_compression_level=6,
            export_draco_position_quantization=14,
            export_draco_normal_quantization=10,
            export_draco_texcoord_quantization=12,
            export_draco_generic_quantization=12,
        )
    finally:
        for node,original in swaps:
            node.image=original
        for image in runtime_images:
            if image.users==0:
                bpy.data.images.remove(image)
    budget=3*1024*1024 if asset=='protagonist' else 2*1024*1024
    if path.stat().st_size>budget:
        raise RuntimeError(f'{asset} runtime GLB {path.stat().st_size} exceeds {budget} byte per-asset budget')
    return path


def look_at(obj, target):
    obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()


def render_all_actions_proof(asset, mesh, arm, clip_names):
    mn,mx=bounds(mesh); c=(mn+mx)*0.5; dims=mx-mn
    rows=len(clip_names); collection=bpy.data.collections.new('AllActionsProof')
    bpy.context.scene.collection.children.link(collection)
    deps=bpy.context.evaluated_depsgraph_get()
    records=[]; relative_bounds=[]
    for row,name in enumerate(clip_names):
        action=bpy.data.actions[name]
        start=int(action.get('frame_start',round(action.frame_range[0]))); end=int(action.get('frame_end',round(action.frame_range[1])))
        frames=[start,(start+end)//2,end]; row_records=[]
        assign_action(arm, action)
        for col,frame in enumerate(frames):
            bpy.context.scene.frame_set(frame); deps.update()
            evaluated=mesh.evaluated_get(deps)
            snap_data=bpy.data.meshes.new_from_object(evaluated,preserve_all_data_layers=True,depsgraph=deps)
            snap=bpy.data.objects.new(f'{name}_{frame}',snap_data); collection.objects.link(snap)
            snap.matrix_world=mesh.matrix_world.copy()
            corners=[snap.matrix_world@Vector(corner) for corner in snap.bound_box]
            bmin=Vector(tuple(min(p[i] for p in corners) for i in range(3)))
            bmax=Vector(tuple(max(p[i] for p in corners) for i in range(3)))
            center=(bmin+bmax)*0.5
            row_records.append({'snap':snap,'frame':frame,'col':col,'bmin':bmin,'bmax':bmax,'center':center})
        start_center=row_records[0]['center']
        for record in row_records:
            relative_bounds.append((record['bmin']-start_center,record['bmax']-start_center))
        records.append({'name':name,'row':row,'start_center':start_center,'snapshots':row_records})
    arm.animation_data.action=None
    rel_min=Vector(tuple(min(pair[0][i] for pair in relative_bounds) for i in range(3)))
    rel_max=Vector(tuple(max(pair[1][i] for pair in relative_bounds) for i in range(3)))
    cell_w=max((rel_max.x-rel_min.x)*1.30,dims.x*1.30,0.12)
    cell_h=max((rel_max.z-rel_min.z)*1.38,dims.z*1.38,0.16)
    row_offsets={}
    snapshot_objects=[]
    for record in records:
        z_slot=(rows-1-record['row'])*cell_h
        offsets=[]
        for snapshot in record['snapshots']:
            target_start_center=Vector(((snapshot['col']-1)*cell_w,c.y,z_slot))
            snapshot['snap'].matrix_world.translation += target_start_center-record['start_center']
            delta=snapshot['center']-record['start_center']
            offsets.append({'frame':snapshot['frame'],'center_delta':[round(float(v),6) for v in delta]})
            snapshot_objects.append(snapshot['snap'])
        row_offsets[record['name']]=offsets
    label_mat=bpy.data.materials.new('ProofLabelMaterial'); label_mat.diffuse_color=(1,1,1,1)
    label_objects=[]
    label_x=-cell_w+rel_min.x-0.16*cell_w
    for row,name in enumerate(clip_names):
        z_slot=(rows-1-row)*cell_h
        curve=bpy.data.curves.new(f'{name}LabelData','FONT'); curve.body=name; curve.align_x='RIGHT'; curve.size=cell_h*0.13
        text=bpy.data.objects.new(f'{name}Label',curve); collection.objects.link(text); text.data.materials.append(label_mat)
        text.rotation_euler=(math.pi/2,0,0); text.location=(label_x,mn.y-0.18*max(dims.y,0.1),z_slot+0.38*cell_h)
        label_objects.append(text)
    header_z=(rows-1)*cell_h+rel_max.z+0.18*cell_h
    for col,title in enumerate(('START','MID','END')):
        curve=bpy.data.curves.new(f'{title}LabelData','FONT'); curve.body=title; curve.align_x='CENTER'; curve.size=cell_h*0.11
        text=bpy.data.objects.new(f'{title}Label',curve); collection.objects.link(text); text.data.materials.append(label_mat)
        text.rotation_euler=(math.pi/2,0,0); text.location=((col-1)*cell_w,mn.y-0.18*max(dims.y,0.1),header_z)
        label_objects.append(text)
    bpy.context.view_layer.update()
    renderables=snapshot_objects+label_objects
    proof_corners=[obj.matrix_world@Vector(corner) for obj in renderables for corner in obj.bound_box]
    content_min=Vector(tuple(min(p[i] for p in proof_corners) for i in range(3)))
    content_max=Vector(tuple(max(p[i] for p in proof_corners) for i in range(3)))
    content_w=content_max.x-content_min.x; content_h=content_max.z-content_min.z
    pad_x=max(content_w*0.08,cell_w*0.10); pad_z=max(content_h*0.08,cell_h*0.10)
    framed_w=content_w+2*pad_x; framed_h=content_h+2*pad_z
    grid_center=Vector(((content_min.x+content_max.x)*0.5,c.y,(content_min.z+content_max.z)*0.5))
    cam_data=bpy.data.cameras.new('ProofCameraData'); cam=bpy.data.objects.new('ProofCamera',cam_data); collection.objects.link(cam)
    cam.location=grid_center+Vector((0,-max(dims.y,0.1)*8,0)); look_at(cam,grid_center); cam_data.type='ORTHO'
    scene=bpy.context.scene; scene.camera=cam; scene.render.resolution_x=1200; scene.render.resolution_y=max(640,min(2400,rows*280)); scene.render.resolution_percentage=100
    aspect=scene.render.resolution_x/scene.render.resolution_y
    if aspect>=1.0:
        cam_data.ortho_scale=max(framed_w,framed_h*aspect)
        view_w=cam_data.ortho_scale; view_h=view_w/aspect
    else:
        cam_data.ortho_scale=max(framed_h,framed_w/aspect)
        view_h=cam_data.ortho_scale; view_w=view_h*aspect
    view_min=Vector((grid_center.x-view_w*0.5,0,grid_center.z-view_h*0.5))
    view_max=Vector((grid_center.x+view_w*0.5,0,grid_center.z+view_h*0.5))
    contained=(content_min.x>=view_min.x and content_max.x<=view_max.x and content_min.z>=view_min.z and content_max.z<=view_max.z)
    framing={
        'contained':bool(contained),
        'content_bounds_xz':[round(content_min.x,6),round(content_max.x,6),round(content_min.z,6),round(content_max.z,6)],
        'view_bounds_xz':[round(view_min.x,6),round(view_max.x,6),round(view_min.z,6),round(view_max.z,6)],
        'padding_x':round(pad_x,6),'padding_z':round(pad_z,6),
        'row_snapshot_center_offsets':row_offsets,
    }
    for name,offset,energy in [('ProofKey',(1.8,-2.5,3.0),450),('ProofFill',(-2.0,-1.5,1.0),240),('ProofRim',(0,2.0,2.5),300)]:
        ld=bpy.data.lights.new(name+'Data','AREA'); ld.energy=energy*max(dims.length,0.35)**2; ld.size=max(dims.length,0.2)*4
        light=bpy.data.objects.new(name,ld); collection.objects.link(light); light.location=grid_center+Vector(offset)*max(dims.length,0.2); look_at(light,grid_center)
    mesh.hide_render=True; arm.hide_render=True
    scene.render.engine='BLENDER_EEVEE'; scene.render.film_transparent=False; scene.world.color=(0.018,0.025,0.04)
    scene.view_settings.look='AgX - Medium High Contrast'; scene.view_settings.exposure=-0.2
    proof=OUT/f'{asset}_all_actions.png'; scene.render.image_settings.file_format='PNG'; scene.render.filepath=str(proof)
    bpy.ops.render.render(write_still=True)
    mesh.hide_render=False; arm.hide_render=False
    for obj in list(collection.objects):
        bpy.data.objects.remove(obj,do_unlink=True)
    bpy.data.collections.remove(collection)
    return proof,framing


def asset_record(asset, source, mesh, arm, clips, blend_path, glb_path, proof_path, proof_framing, strategy, limitations):
    mn,mx=bounds(mesh)
    return {
        'source':str(source.relative_to(ROOT)).replace('\\','/'),
        'outputs':{
            'blend':str(blend_path.relative_to(ROOT)).replace('\\','/'),
            'glb':str(glb_path.relative_to(ROOT)).replace('\\','/'),
            'all_actions_proof':str(proof_path.relative_to(ROOT)).replace('\\','/'),
        },
        'proof_framing':proof_framing,
        'source_mesh':{'vertices':len(mesh.data.vertices),'polygons':len(mesh.data.polygons),'materials':[s.material.name if s.material else None for s in mesh.material_slots]},
        'runtime_glb_bytes':glb_path.stat().st_size,
        'bounds':{'min':[round(x,6) for x in mn],'max':[round(x,6) for x in mx]},
        'rig_strategy':strategy,
        'bones':[{'name':b.name,'parent':b.parent.name if b.parent else None,'deform':b.use_deform} for b in arm.data.bones],
        'clips':[{'name':n,'frame_start':int(bpy.data.actions[n]['frame_start']),'frame_end':int(bpy.data.actions[n]['frame_end']),'layer':bpy.data.actions[n].get('layer','FullBody')} for n in clips],
        'limitations':limitations,
    }


def build(asset,cfg):
    print('BUILDING',asset)
    clear_scene()
    source=cfg['source']
    if asset=='protagonist':
        mesh,arm=import_primary(source,keep_armature=True)
        if arm is None: raise RuntimeError('Chosen protagonist source has no armature')
        mesh.name='ProtagonistMesh'; arm.name='ProtagonistRig'; arm.data.name='ProtagonistRigData'
        add_existing_hero_controls(arm); cohere_existing_component_weights(mesh,arm); bind_hero_arms(mesh,arm); hero_actions(arm, mesh)
        strategy='Preserved the Mixamo hierarchy, then bound each disconnected island to the arm bone that runs through it and returned coat islands that had been left on the forearms to the nearest torso bone. Locomotion swings the shoulder, upper arm and elbow opposite the legs. Shoot still keys the upper body.'
        limitations=['Source is a compact 0.1 m chibi mesh and retains its original scale.', 'Arm and coat weights are rigid per island. The shoulder seam does not have a painted gradient.']
    else:
        mesh,_=import_primary(source)
        mesh.name={'slime':'SlimeMesh','hound':'HoundMesh','ogre':'OgreMesh','boss_knight':'BossKnightMesh','chest':'ChestMesh'}[asset]
        mn,mx=bounds(mesh)
        if asset=='slime':
            arm=create_armature('SlimeRig',slime_specs(mn,mx)); weight_slime(mesh,arm); slime_actions(arm)
            strategy='Two-bone slime rig with non-deforming SlimeRoot and one vertical SlimeCore deform bone. Every vertex has uniform Core ownership; action scales are authored in the bone-local basis so local Y controls world height and local X/Z control horizontal spread.'
            limitations=['No shape keys were added because the imported surface is split into 23 disconnected topology islands; uniform skeletal scaling preserves vertex order and inter-island alignment.']
        elif asset=='hound':
            arm=create_armature('HoundRig',hound_specs(mesh)); weight_hound(mesh,arm); hound_actions(arm)
            strategy='Quadruped pivots are fitted to four measured low-vertex paw clusters and the diagonal source stance. Limb islands retain their measured Upper/Lower/Paw classification so every keyed lower-leg chain has real deformation targets; the source supports one weighted tail bone.'
            limitations=['Generated source is heavily fragmented (924 islands), so components are rigid by anatomical segment rather than organically painted.', 'No jaw bone or IK controls were added in this first pass.']
        elif asset=='ogre':
            arm=create_armature('OgreRig',humanoid_specs(mn,mx,heavyweight=True)); weight_ogre(mesh,arm); humanoid_actions(arm,knight=False)
            strategy='Custom broad heavyweight hierarchy fitted to the measured bounds. Coincident rest-surface topology first classifies rigid islands; the continuous chest/arm contact cluster then receives deterministic neighboring-bone blends across Chest, UpperArm, Forearm, and Hand. AttackPrimary is a belly charge: the protruding belly pulls back, then drives straight forward.'
            limitations=['A two-fist ground pound tears the continuous chest/arm skin, so the attack uses the rigid belly instead of the arms.', 'The source is fragmented into 893 islands; armor and isolated details remain component-rigid while the continuous chest/arm surface uses geometry-driven weights rather than artist-painted weights.']
        elif asset=='boss_knight':
            specs=fit_knight_accessories(mesh, humanoid_specs(mn,mx,heavyweight=False,knight=True))
            arm=create_armature('BossKnightRig',specs); weight_knight(mesh,arm); humanoid_actions(arm,knight=True,mesh=mesh)
            strategy='Armor stays on the humanoid chain. Only the long thin longsword islands, plus shells sitting on that blade, are weighted to one sword bone parented to the right hand. The bone is refit through that blade so the sweep carries one sword from the right side through the front of the chest to the left. The cape is four rigid-island bones aimed back behind the shoulders.'
            limitations=['The cape is a four-bone hang with lagged sway, not a simulated cloth solver. Each source island stays rigid.', 'Hip and thigh islands that only pass near the sword stay on the body, so the slash cannot throw a second blade.']
        elif asset=='chest':
            specs,seam=chest_specs(mn,mx); arm=create_armature('ChestRig',specs); weight_chest(mesh,arm,seam); chest_actions(arm)
            strategy='Minimal two-bone rigid setup. Whole connected components are classified by majority position above the measured seam; ChestLid rotates about bone-local Y, aligned to the rear world-X hinge.'
            limitations=['Lock and trim are fused into the one source mesh, so whole-island ownership favors rigidity over independent lock motion.', 'Object-hinge animation was not possible because the source contains one mesh object.']
    finalize_actions(arm,cfg['clips'])
    arm.data['rigged_v1_asset']=asset
    arm['source_path']=str(source.relative_to(ROOT)).replace('\\','/')
    for pb in arm.pose.bones: pb.rotation_mode='XYZ'
    blend_path=OUT/f'{asset}_rigged_v1.blend'
    bpy.context.scene.render.fps=FPS
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path),compress=True)
    glb_path=export_glb(asset,mesh,arm)
    proof_path,proof_framing=render_all_actions_proof(asset,mesh,arm,cfg['clips'])
    MANIFEST['assets'][asset]=asset_record(asset,source,mesh,arm,cfg['clips'],blend_path,glb_path,proof_path,proof_framing,strategy,limitations)
    print('BUILT',asset,blend_path,glb_path,proof_path,glb_path.stat().st_size)


def main():
    argv=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    selected=[name for name in argv if name in ASSETS] or list(ASSETS)
    manifest_path=OUT/'build_manifest.json'
    if set(selected)!=set(ASSETS) and manifest_path.exists():
        previous=json.loads(manifest_path.read_text(encoding='utf-8'))
        MANIFEST['assets'].update(previous.get('assets', {}))
    errors={}
    for asset in selected:
        cfg=ASSETS[asset]
        try:
            build(asset,cfg)
        except Exception as exc:
            errors[asset]={'error':str(exc),'traceback':traceback.format_exc()}
            print('BUILD_FAILED',asset,traceback.format_exc())
            break
    MANIFEST['errors']=errors
    MANIFEST['runtime_glb_total_bytes']=sum(Path(ROOT/data['outputs']['glb']).stat().st_size for data in MANIFEST['assets'].values())
    MANIFEST['runtime_glb_budget_bytes']=8*1024*1024
    if not errors and MANIFEST['runtime_glb_total_bytes']>MANIFEST['runtime_glb_budget_bytes']:
        errors['package']={'error':f"Runtime GLB total {MANIFEST['runtime_glb_total_bytes']} exceeds {MANIFEST['runtime_glb_budget_bytes']} bytes"}
    (OUT/'build_manifest.json').write_text(json.dumps(MANIFEST,indent=2),encoding='utf-8')
    if errors: raise SystemExit(1)
    print('BUILD_ALL_OK',OUT,'TOTAL_GLB_BYTES',MANIFEST['runtime_glb_total_bytes'])

if __name__=='__main__':
    main()

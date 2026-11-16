import bpy
import json
import math
import traceback
import re
from pathlib import Path
from mathutils import Vector, Matrix
from mathutils.kdtree import KDTree
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from blender_build_rigged_v1 import render_all_actions_proof, connected_components

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'models'/'rigged_v1'
MANIFEST=json.loads((OUT/'build_manifest.json').read_text(encoding='utf-8'))
REQUIRED={name:[c['name'] for c in data['clips']] for name,data in MANIFEST['assets'].items()}
REPORT={'blender':bpy.app.version_string,'validation_scope':'Clean-scene GLB re-import; every frame of every required clip sampled on evaluated skinned vertices; all-action labeled contact sheets','assets':{},'overall_pass':False}

RIG_GATES={
    'protagonist':{'mode':'component_coherent_source_blend','robust_min':0.80,'robust_max':1.20,'absolute_min':0.45,'absolute_max':1.55,'outlier_min':0.75,'outlier_max':1.30,'max_outlier_fraction':0.002,'bounds_min':0.85,'bounds_max':1.25,'neighbor_diag':0.08,'short_edge_diag':1e-7,'robust_tail_fraction':0.05},
    'slime':{'mode':'authored_anisotropic','edge_min':0.18,'edge_max':1.70,'bounds_min':0.80,'bounds_max':1.50,'neighbor_diag':0.06,'short_edge_diag':1e-7},
    'hound':{'mode':'rigid_components','edge_min':0.985,'edge_max':1.015,'bounds_min':0.85,'bounds_max':1.25,'neighbor_diag':0.06,'short_edge_diag':1e-7},
    'ogre':{'mode':'component_rigid_contact_corrected','robust_min':0.985,'robust_max':1.015,'absolute_min':0.95,'absolute_max':1.05,'outlier_min':0.98,'outlier_max':1.02,'max_outlier_fraction':0.001,'bounds_min':0.80,'bounds_max':1.30,'neighbor_diag':0.14,'surface_neighbor_diag':0.02,'surface_neighbor_search_diag':5e-6,'short_edge_diag':1e-7,'robust_tail_fraction':0.05},
    # The sheathed sword sits inside the rest box. A front-to-side slash reaches 1.43x that diagonal without stretching edges.
    'boss_knight':{'mode':'rigid_components','edge_min':0.985,'edge_max':1.015,'bounds_min':0.85,'bounds_max':1.50,'neighbor_diag':0.06,'short_edge_diag':1e-7},
    'chest':{'mode':'rigid_components','edge_min':0.985,'edge_max':1.015,'bounds_min':0.85,'bounds_max':1.35,'neighbor_diag':0.06,'short_edge_diag':1e-7},
}

WORLD_MOTION_EXPECTATIONS={
    ('protagonist','MoveForward'):{'root':'GameRoot','axis':1,'sign':-1,'minimum_ground_displacement':0.015},
    ('protagonist','MoveBackward'):{'root':'GameRoot','axis':1,'sign':1,'minimum_ground_displacement':0.012},
    ('ogre','WalkHeavy'):{'root':'Root','axis':1,'sign':-1,'minimum_ground_displacement':1.0},
    ('boss_knight','Walk'):{'root':'Root','axis':1,'sign':-1,'minimum_ground_displacement':1.4},
    ('slime','HopMove'):{'root':'SlimeRoot','hop':True,'minimum_airborne_height':0.045,'minimum_forward_peak':0.07},
}

def clear():
    if bpy.context.object and bpy.context.object.mode!='OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj,do_unlink=True)
    for collection in (bpy.data.actions,bpy.data.armatures,bpy.data.meshes,bpy.data.curves,bpy.data.cameras,bpy.data.lights,bpy.data.materials,bpy.data.images):
        for block in list(collection):
            if getattr(block,'users',0)==0: collection.remove(block)

def finite(values):
    return all(math.isfinite(float(v)) for v in values)

def object_finite(obj):
    return finite(v for row in obj.matrix_world for v in row)

def action_fcurves(action):
    try:
        return list(action.fcurves)
    except Exception:
        curves=[]
        try:
            for layer in action.layers:
                for strip in layer.strips:
                    for slot in action.slots:
                        bag=strip.channelbag(slot)
                        if bag: curves.extend(list(bag.fcurves))
        except Exception:
            pass
        return curves


def evaluated_positions(mesh):
    deps=bpy.context.evaluated_depsgraph_get(); evaluated=mesh.evaluated_get(deps)
    evaluated_mesh=evaluated.to_mesh()
    try:
        return [evaluated.matrix_world@v.co for v in evaluated_mesh.vertices]
    finally:
        evaluated.to_mesh_clear()

def component_centroids(positions,components):
    return [sum((positions[index] for index in component),Vector())/len(component) for component in components]


def rotation_is_neutral(pb):
    if pb.rotation_mode=='QUATERNION':
        q=pb.rotation_quaternion
        return abs(abs(q.w)-1.0)<=1e-8 and max(abs(q.x),abs(q.y),abs(q.z))<=1e-8
    if pb.rotation_mode=='AXIS_ANGLE':
        return abs(pb.rotation_axis_angle[0])<=1e-8
    return max(abs(value) for value in pb.rotation_euler)<=1e-8


def reset_pose_neutral(arm):
    for pb in arm.pose.bones:
        pb.location=(0,0,0); pb.scale=(1,1,1)
        if pb.rotation_mode=='QUATERNION':
            pb.rotation_quaternion=(1,0,0,0)
        elif pb.rotation_mode=='AXIS_ANGLE':
            pb.rotation_axis_angle=(0,0,1,0)
        else:
            pb.rotation_euler=(0,0,0)


def neutral_pose_state(arm):
    return (
        arm.animation_data is not None
        and arm.animation_data.action is None
        and bpy.context.scene.frame_current==1
        and all(pb.location.length<=1e-8 and rotation_is_neutral(pb)
                and max(abs(value-1.0) for value in pb.scale)<=1e-8 for pb in arm.pose.bones)
    )


def boundary_signature(mesh,arm):
    positions=evaluated_positions(mesh)
    pmin=Vector(tuple(min(point[axis] for point in positions) for axis in range(3)))
    pmax=Vector(tuple(max(point[axis] for point in positions) for axis in range(3)))
    bones={}
    for pb in arm.pose.bones:
        location,rotation,scale=pb.matrix_basis.decompose()
        bones[pb.name]=[location.length,rotation.angle,*scale]
    return {'bounds':[*pmin,*pmax],'bones':bones}


def sequential_boundary_signatures(mesh,arm,actions,names):
    signatures={}
    arm.animation_data_create()
    for name in names:
        action=actions[name]
        play_action(arm, action)
        start,end=(int(round(value)) for value in action.frame_range)
        for label,frame in (('start',start),('end',end)):
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            signatures[f'{name}:{label}']=boundary_signature(mesh,arm)
    return signatures


def signature_delta(left,right):
    if set(left)!=set(right):
        return math.inf,math.inf
    bounds_delta=0.0; bone_delta=0.0
    for key in left:
        bounds_delta=max(bounds_delta,max(abs(a-b) for a,b in zip(left[key]['bounds'],right[key]['bounds'])))
        if set(left[key]['bones'])!=set(right[key]['bones']):
            return math.inf,math.inf
        for bone_name in left[key]['bones']:
            bone_delta=max(bone_delta,max(abs(a-b) for a,b in zip(left[key]['bones'][bone_name],right[key]['bones'][bone_name])))
    return bounds_delta,bone_delta


def behavior_signature_delta(left,right,left_neutral,right_neutral):
    if set(left)!=set(right):
        return math.inf,math.inf
    def bounds_invariants(signature,neutral):
        bounds=signature['bounds']; rest=neutral['bounds']
        dimensions=sorted(bounds[axis+3]-bounds[axis] for axis in range(3))
        rest_dimensions=sorted(rest[axis+3]-rest[axis] for axis in range(3))
        scale=max(sum(value*value for value in rest_dimensions)**0.5,1e-9)
        dimension_motion=tuple((dimensions[axis]-rest_dimensions[axis])/scale for axis in range(3))
        center=Vector(tuple((bounds[axis]+bounds[axis+3])*0.5 for axis in range(3)))
        rest_center=Vector(tuple((rest[axis]+rest[axis+3])*0.5 for axis in range(3)))
        return dimension_motion,(center-rest_center).length/scale
    dimension_delta=0.0; center_motion_delta=0.0
    for key in left:
        left_dimensions,left_center_motion=bounds_invariants(left[key],left_neutral)
        right_dimensions,right_center_motion=bounds_invariants(right[key],right_neutral)
        dimension_delta=max(dimension_delta,max(abs(a-b) for a,b in zip(left_dimensions,right_dimensions)))
        center_motion_delta=max(center_motion_delta,abs(left_center_motion-right_center_motion))
    return dimension_delta,center_motion_delta


def keyed_deform_bone_audit(arm,actions,names,group_totals):
    keyed=set()
    pattern=re.compile(r'^pose\.bones\["([^"]+)"\]')
    for name in names:
        for curve in action_fcurves(actions[name]):
            match=pattern.match(curve.data_path)
            nonconstant=(curve.keyframe_points
                         and max(point.co.y for point in curve.keyframe_points)-min(point.co.y for point in curve.keyframe_points)>1e-5)
            if nonconstant and match and arm.data.bones.get(match.group(1)) and arm.data.bones[match.group(1)].use_deform:
                keyed.add(match.group(1))
    memo={}
    def has_target(bone):
        if bone.name in memo:
            return memo[bone.name]
        memo[bone.name]=(group_totals.get(bone.name,0.0)>0
                         or any(child.use_deform and has_target(child) for child in bone.children))
        return memo[bone.name]
    rows=[{'bone':name,'direct_weight':group_totals.get(name,0.0),'weighted_self_or_descendant':has_target(arm.data.bones[name])}
          for name in sorted(keyed)]
    return rows,all(row['weighted_self_or_descendant'] for row in rows)

def action_frames(action):
    start,end=(int(round(x)) for x in action.frame_range)
    return list(range(start,end+1))

def percentile_sorted(values,fraction):
    if not values:
        return math.nan
    position=(len(values)-1)*fraction
    low=int(math.floor(position)); high=int(math.ceil(position))
    if low==high:
        return values[low]
    return values[low]*(high-position)+values[high]*(position-low)

def _arm_bone(owner):
    if not owner or 'Socket' in owner:
        return False
    if 'Hand' in owner and not owner.endswith('Hand') and not owner.endswith('.L') and not owner.endswith('.R'):
        return False
    return any(token in owner for token in (
        'Shoulder', 'ForeArm', 'UpperArm', 'LeftArm', 'RightArm', 'LeftHand', 'RightHand', 'Hand.L', 'Hand.R',
    ))


def intended_prop_separation(owner_a, owner_b):
    """Sword, belly, cape bones and distinct arm bones may travel apart. Islands on one bone stay gated."""
    def family(owner):
        if owner=='Sword': return 'Sword'
        if owner=='Belly': return 'Belly'
        if owner and owner.startswith('Cape.'): return owner
        if _arm_bone(owner): return 'Arm:'+owner
        return 'Body'
    return family(owner_a)!=family(owner_b)


def play_action(arm, action):
    arm.animation_data_create()
    arm.animation_data.action=action
    slots=list(getattr(action, 'slots', []) or []) if action is not None else []
    if slots and hasattr(arm.animation_data, 'action_slot'):
        arm.animation_data.action_slot=slots[0]

def validate_evaluated_clip(asset,mesh,arm,action,topology,rest_positions,rest_edge_lengths,neighbor_links,surface_neighbor_pairs,negative_control_pairs,diag,owners=None):
    gate=RIG_GATES[asset]
    curves=action_fcurves(action); frames=action_frames(action)
    start,end=(int(round(x)) for x in action.frame_range)
    boundary_complete=all(
        any(abs(point.co.x-start)<1e-4 for point in curve.keyframe_points)
        and any(abs(point.co.x-end)<1e-4 for point in curve.keyframe_points)
        for curve in curves
    )
    play_action(arm, action)
    first=None; max_motion=0.0; finite_ok=True; min_edge_ratio=math.inf; max_edge_ratio=0.0
    robust_min_edge_ratio=math.inf; robust_max_edge_ratio=0.0
    min_edge_record=None; max_edge_record=None; outlier_edge_samples=0; total_edge_samples=0
    min_bounds_ratio=math.inf; max_bounds_ratio=0.0; max_neighbor_separation_delta=0.0; worst_neighbor_component=None
    max_surface_neighbor_delta=0.0; worst_surface_neighbor=None
    max_negative_control_delta=0.0; worst_negative_control=None
    max_cross_owner_negative_delta=0.0; worst_cross_owner_negative=None
    motion_spec=WORLD_MOTION_EXPECTATIONS.get((asset,action.name)); root_world_positions=[]
    for frame in frames:
        bpy.context.scene.frame_set(frame)
        if motion_spec:
            root_world_positions.append(arm.matrix_world@arm.pose.bones[motion_spec['root']].matrix.translation)
        positions=evaluated_positions(mesh)
        finite_ok &= all(finite(p) for p in positions)
        if first is None:
            first=positions
        else:
            max_motion=max(max_motion,max((positions[i]-first[i]).length for i in range(len(positions))))
        pmin=Vector(tuple(min(p[i] for p in positions) for i in range(3)))
        pmax=Vector(tuple(max(p[i] for p in positions) for i in range(3)))
        bounds_ratio=(pmax-pmin).length/max(diag,1e-9)
        min_bounds_ratio=min(min_bounds_ratio,bounds_ratio); max_bounds_ratio=max(max_bounds_ratio,bounds_ratio)
        edge_rows=[((a,b),rest_length,(positions[a]-positions[b]).length/rest_length) for (a,b),rest_length in rest_edge_lengths]
        if edge_rows:
            frame_min=min(edge_rows,key=lambda row:row[2]); frame_max=max(edge_rows,key=lambda row:row[2])
            if frame_min[2]<min_edge_ratio:
                min_edge_ratio=frame_min[2]; min_edge_record={'frame':frame,'vertices':list(frame_min[0]),'rest_length':frame_min[1],'ratio':frame_min[2]}
            if frame_max[2]>max_edge_ratio:
                max_edge_ratio=frame_max[2]; max_edge_record={'frame':frame,'vertices':list(frame_max[0]),'rest_length':frame_max[1],'ratio':frame_max[2]}
            edge_ratios=sorted(row[2] for row in edge_rows)
            tail=gate.get('robust_tail_fraction',0.01)
            robust_min_edge_ratio=min(robust_min_edge_ratio,percentile_sorted(edge_ratios,tail))
            robust_max_edge_ratio=max(robust_max_edge_ratio,percentile_sorted(edge_ratios,1.0-tail))
            if 'outlier_min' in gate:
                outlier_edge_samples+=sum(ratio<gate['outlier_min'] or ratio>gate['outlier_max'] for ratio in edge_ratios)
                total_edge_samples+=len(edge_ratios)
        centroids=component_centroids(positions,topology)
        for component_index,links in enumerate(neighbor_links):
            if not links:
                continue
            relevant=links
            if owners is not None:
                relevant=[(neighbor,rest_distance) for neighbor,rest_distance in links
                          if not intended_prop_separation(owners[component_index],owners[neighbor])]
            if not relevant:
                continue
            delta=min(abs((centroids[component_index]-centroids[neighbor]).length-rest_distance) for neighbor,rest_distance in relevant)
            if delta>max_neighbor_separation_delta:
                max_neighbor_separation_delta=delta; worst_neighbor_component=component_index
        for a,b,rest_distance,component_a,component_b in surface_neighbor_pairs:
            relative_delta=((positions[a]-rest_positions[a])-(positions[b]-rest_positions[b])).length
            if relative_delta>max_surface_neighbor_delta:
                max_surface_neighbor_delta=relative_delta
                worst_surface_neighbor={'frame':frame,'vertices':[a,b],'components':[component_a,component_b],
                                        'rest_surface_distance':rest_distance,'relative_displacement':relative_delta}
        for simulated,other,component_simulated,component_other,bone_name,cross_owner in negative_control_pairs:
            rest_armature=arm.matrix_world.inverted()@rest_positions[simulated]
            # Exercise a rejected rigid ownership independently of the
            # production clip. Every traversed material contact contributes a
            # candidate; cross-dominant-owner links are tracked separately.
            synthetic_pose=arm.pose.bones[bone_name].matrix@Matrix.Rotation(math.radians(20.0),4,'X')
            simulated_position=arm.matrix_world@(synthetic_pose@arm.data.bones[bone_name].matrix_local.inverted()@rest_armature)
            relative_delta=((simulated_position-rest_positions[simulated])-(positions[other]-rest_positions[other])).length
            record={'frame':frame,'vertices':[simulated,other],
                    'components':[component_simulated,component_other],
                    'simulated_old_owner':bone_name,'synthetic_local_rotation_degrees':20.0,
                    'cross_dominant_owner_contact':cross_owner,
                    'relative_displacement':relative_delta}
            if relative_delta>max_negative_control_delta:
                max_negative_control_delta=relative_delta
                worst_negative_control=record
            if cross_owner and relative_delta>max_cross_owner_negative_delta:
                max_cross_owner_negative_delta=relative_delta
                worst_cross_owner_negative=record
    arm.animation_data.action=None
    nonconstant_curves=[curve for curve in curves if curve.keyframe_points and max(p.co.y for p in curve.keyframe_points)-min(p.co.y for p in curve.keyframe_points)>1e-8]
    nonconstant=len(nonconstant_curves)
    rotation_nonconstant=sum('rotation_' in curve.data_path for curve in nonconstant_curves)
    rotation_only=bool(nonconstant_curves) and rotation_nonconstant==len(nonconstant_curves)
    rotation_only_motion_gate_pass=not rotation_only or max_motion>diag*1e-3
    outlier_fraction=outlier_edge_samples/max(total_edge_samples,1)
    if 'robust_min' in gate:
        robust_gate_pass=robust_min_edge_ratio>=gate['robust_min'] and robust_max_edge_ratio<=gate['robust_max']
        absolute_extrema_gate_pass=min_edge_ratio>=gate['absolute_min'] and max_edge_ratio<=gate['absolute_max']
        outlier_fraction_gate_pass=outlier_fraction<=gate['max_outlier_fraction']
        edge_gate_pass=robust_gate_pass and absolute_extrema_gate_pass and outlier_fraction_gate_pass
        edge_gate_measurement=f"{int(gate['robust_tail_fraction']*100)}th/{int((1.0-gate['robust_tail_fraction'])*100)}th percentile plus absolute extrema and total sampled outlier fraction; only numerically coincident rest edges are excluded"
    else:
        robust_gate_pass=True; absolute_extrema_gate_pass=True; outlier_fraction_gate_pass=True
        edge_gate_pass=min_edge_ratio>=gate['edge_min'] and max_edge_ratio<=gate['edge_max']
        edge_gate_measurement='all nondegenerate rest edges; extrema gated'
    motion_result=None; motion_gate_pass=True
    if motion_spec:
        start_position=root_world_positions[0]; end_position=root_world_positions[-1]
        height_offsets=[position.z-start_position.z for position in root_world_positions]
        if motion_spec.get('hop'):
            forward_offsets=[start_position.y-position.y for position in root_world_positions]
            motion_gate_pass=(max(height_offsets)>=motion_spec['minimum_airborne_height']
                              and min(height_offsets)>=-diag*1e-4
                              and abs(height_offsets[-1])<=diag*1e-4
                              and max(forward_offsets)>=motion_spec['minimum_forward_peak'])
            motion_result={'type':'airborne_hop','peak_world_height':max(height_offsets),'minimum_world_height':min(height_offsets),
                           'net_world_height':height_offsets[-1],'peak_forward_ground_displacement':max(forward_offsets)}
        else:
            axis=motion_spec['axis']; signed_displacement=motion_spec['sign']*(end_position[axis]-start_position[axis])
            cross_axis=1-axis
            max_height_drift=max(abs(offset) for offset in height_offsets)
            max_cross_axis_drift=max(abs(position[cross_axis]-start_position[cross_axis]) for position in root_world_positions)
            motion_gate_pass=(signed_displacement>=motion_spec['minimum_ground_displacement']
                              and max_height_drift<=diag*1e-4 and max_cross_axis_drift<=diag*1e-4)
            motion_result={'type':'signed_ground_locomotion','world_axis':'Y','expected_sign':motion_spec['sign'],
                           'signed_ground_displacement':signed_displacement,'max_world_height_drift':max_height_drift,
                           'max_cross_axis_drift':max_cross_axis_drift}
        motion_result['root_bone']=motion_spec['root']; motion_result['pass']=motion_gate_pass
        motion_result['sampled_world_positions']=[[float(value) for value in position] for position in root_world_positions]
    bounds_gate_pass=min_bounds_ratio>=gate['bounds_min'] and max_bounds_ratio<=gate['bounds_max']
    neighbor_gate_pass=max_neighbor_separation_delta<=gate['neighbor_diag']*diag
    surface_neighbor_gate_pass=('surface_neighbor_diag' not in gate
                                or max_surface_neighbor_delta<=gate['surface_neighbor_diag']*diag)
    negative_control_required=asset=='ogre' and action.name=='AttackPrimary'
    negative_control_pass=(not negative_control_required
                           or (max_negative_control_delta>gate['surface_neighbor_diag']*diag
                               and max_cross_owner_negative_delta>gate['surface_neighbor_diag']*diag))
    passed=(len(curves)>0 and nonconstant>0 and max_motion>1e-6 and finite_ok and boundary_complete
            and rotation_only_motion_gate_pass and edge_gate_pass and bounds_gate_pass and neighbor_gate_pass
            and surface_neighbor_gate_pass and negative_control_pass and motion_gate_pass)
    return {
        'name':action.name,'present':True,'frame_range':[float(x) for x in action.frame_range],
        'sample_frames':frames,'evaluated_frame_count':len(frames),'channel_count':len(curves),
        'nonconstant_channels':nonconstant,'rotation_nonconstant_channels':rotation_nonconstant,
        'rotation_only_clip':rotation_only,'rotation_only_motion_gate_pass':rotation_only_motion_gate_pass,
        'evaluated_vertex_delta':max_motion,'evaluated_vertex_delta_diag_fraction':max_motion/max(diag,1e-9),
        'boundary_keys_complete':boundary_complete,'finite_evaluated_vertices':finite_ok,
        'min_edge_length_ratio':min_edge_ratio,'max_edge_length_ratio':max_edge_ratio,
        'min_edge_record':min_edge_record,'max_edge_record':max_edge_record,
        'robust_lower_edge_ratio':robust_min_edge_ratio,'robust_upper_edge_ratio':robust_max_edge_ratio,
        'outlier_edge_samples':outlier_edge_samples,'total_edge_samples':total_edge_samples,'outlier_fraction':outlier_fraction,
        'robust_edge_gate_pass':robust_gate_pass,'absolute_extrema_gate_pass':absolute_extrema_gate_pass,
        'outlier_fraction_gate_pass':outlier_fraction_gate_pass,
        'edge_gate_mode':gate['mode'],'edge_gate_measurement':edge_gate_measurement,'edge_gate_pass':edge_gate_pass,
        'min_bounds_ratio':min_bounds_ratio,'max_bounds_ratio':max_bounds_ratio,'bounds_gate_pass':bounds_gate_pass,
        'max_geometric_neighbor_separation_delta':max_neighbor_separation_delta,
        'max_geometric_neighbor_separation_diag_fraction':max_neighbor_separation_delta/max(diag,1e-9),
        'worst_geometric_neighbor_component':worst_neighbor_component,'geometric_neighbor_gate_pass':neighbor_gate_pass,
        'nearest_surface_neighbor_relative_displacement':max_surface_neighbor_delta,
        'nearest_surface_neighbor_diag_fraction':max_surface_neighbor_delta/max(diag,1e-9),
        'worst_nearest_surface_neighbor':worst_surface_neighbor,
        'nearest_surface_neighbor_gate_pass':surface_neighbor_gate_pass,
        'old_owner_negative_control_relative_displacement':max_negative_control_delta,
        'old_owner_negative_control_worst':worst_negative_control,
        'cross_owner_negative_control_relative_displacement':max_cross_owner_negative_delta,
        'cross_owner_negative_control_worst':worst_cross_owner_negative,
        'old_owner_negative_control_required':negative_control_required,
        'old_owner_negative_control_pass':negative_control_pass,
        'world_motion':motion_result,'world_motion_gate_pass':motion_gate_pass,
        'pass':passed,
    }

def validate(asset,data):
    blend=ROOT/data['outputs']['blend']
    clear()
    bpy.ops.wm.open_mainfile(filepath=str(blend))
    editable_object_names=[obj.name for obj in bpy.context.scene.objects]
    editable_meshes=[obj for obj in bpy.context.scene.objects if obj.type=='MESH' and (len(obj.data.vertices)>=100 or len(obj.material_slots)>0)]
    editable_arms=[obj for obj in bpy.context.scene.objects if obj.type=='ARMATURE']
    if len(editable_meshes)!=1 or len(editable_arms)!=1:
        raise RuntimeError(f'{asset}: editable blend missing primary mesh/armature')
    editable_mesh=editable_meshes[0]; editable_arm=editable_arms[0]
    editable_actions={action.name:action for action in bpy.data.actions}
    editable_neutral=neutral_pose_state(editable_arm)
    editable_neutral_signature=boundary_signature(editable_mesh,editable_arm)
    editable_forward=sequential_boundary_signatures(editable_mesh,editable_arm,editable_actions,REQUIRED[asset])
    editable_reverse=sequential_boundary_signatures(editable_mesh,editable_arm,editable_actions,list(reversed(REQUIRED[asset])))
    editable_switch_bounds_delta,editable_switch_bone_delta=signature_delta(editable_forward,editable_reverse)
    clear()
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    glb=ROOT/data['outputs']['glb']; bpy.ops.import_scene.gltf(filepath=str(glb),import_pack_images=True)
    imported_meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
    meshes=[o for o in imported_meshes if len(o.data.vertices)>=100 or len(o.material_slots)>0]
    arms=[o for o in bpy.context.scene.objects if o.type=='ARMATURE']
    actions={a.name:a for a in bpy.data.actions}
    checks={
        'mesh_count':len(meshes)==1,
        'armature_count':len(arms)==1,
        'material_count':any(slot.material is not None for mesh_object in meshes for slot in mesh_object.material_slots),
        'required_clips':all(name in actions for name in REQUIRED[asset]),
        'finite_object_transforms':all(object_finite(o) for o in bpy.context.scene.objects),
        'runtime_size_budget':glb.stat().st_size <= (3*1024*1024 if asset=='protagonist' else 2*1024*1024),
        'editable_no_preview_helpers':not any(any(token in name for token in ('Proof','PreviewCamera','ValidationCamera','Key','Fill','Rim')) for name in editable_object_names),
        'editable_saved_neutral_pose':editable_neutral,
        'editable_action_switch_independence':editable_switch_bounds_delta<=1e-6 and editable_switch_bone_delta<=1e-6,
    }
    if not meshes or not arms: raise RuntimeError(f'{asset}: missing mesh/armature')
    mesh=meshes[0]; arm=arms[0]
    arm.animation_data_create(); arm.animation_data.action=None
    bpy.context.scene.frame_set(1); reset_pose_neutral(arm); bpy.context.view_layer.update()
    runtime_neutral_signature=boundary_signature(mesh,arm)
    runtime_forward=sequential_boundary_signatures(mesh,arm,actions,REQUIRED[asset])
    runtime_reverse=sequential_boundary_signatures(mesh,arm,actions,list(reversed(REQUIRED[asset])))
    runtime_switch_bounds_delta,runtime_switch_bone_delta=signature_delta(runtime_forward,runtime_reverse)
    editable_runtime_dimension_delta,editable_runtime_center_motion_delta=behavior_signature_delta(
        editable_forward,runtime_forward,editable_neutral_signature,runtime_neutral_signature)
    checks['runtime_action_switch_independence']=runtime_switch_bounds_delta<=1e-6 and runtime_switch_bone_delta<=1e-6
    checks['editable_runtime_boundary_match']=(editable_runtime_dimension_delta<=0.005
                                               and editable_runtime_center_motion_delta<=0.005)
    imported_material_names=sorted({slot.material.name for slot in mesh.material_slots if slot.material})
    checks['skinning_parenting']=(mesh.parent==arm or any(m.type=='ARMATURE' and m.object==arm for m in mesh.modifiers))
    checks['vertex_groups']=len(mesh.vertex_groups)>0 and all(any(g.weight>0 for g in v.groups) for v in mesh.data.vertices)
    group_totals={group.name:0.0 for group in mesh.vertex_groups}
    for vertex in mesh.data.vertices:
        for assignment in vertex.groups:
            group_totals[mesh.vertex_groups[assignment.group].name]+=assignment.weight
    empty_vertex_groups=sorted(name for name,total in group_totals.items() if total<=0)
    keyed_bone_audit,keyed_bones_have_targets=keyed_deform_bone_audit(arm,actions,REQUIRED[asset],group_totals)
    checks['keyed_deform_bones_have_targets']=keyed_bones_have_targets
    if asset=='slime':
        checks['slime_no_unused_deform_controls']=({bone.name for bone in arm.data.bones}=={'SlimeRoot','SlimeCore'} and set(group_totals).issubset({'SlimeRoot','SlimeCore'}) and group_totals.get('SlimeCore',0)>0 and 'SlimeBase' not in group_totals and 'SlimeTop' not in group_totals)
    arm.animation_data_create(); arm.animation_data.action=None; bpy.context.scene.frame_set(1)
    reset_pose_neutral(arm); bpy.context.view_layer.update()
    rest_positions=evaluated_positions(mesh)
    pmin=Vector(tuple(min(p[i] for p in rest_positions) for i in range(3))); pmax=Vector(tuple(max(p[i] for p in rest_positions) for i in range(3)))
    diag=(pmax-pmin).length
    topology=connected_components(mesh)
    gate=RIG_GATES[asset]
    rest_edges=[]; excluded_short_edges=0
    minimum_rest_edge=diag*gate['short_edge_diag']
    for edge in mesh.data.edges:
        a,b=edge.vertices; length=(rest_positions[a]-rest_positions[b]).length
        if length>minimum_rest_edge:
            rest_edges.append(((a,b),length))
        else:
            excluded_short_edges+=1
    rest_centroids=component_centroids(rest_positions,topology)
    component_bounds=[]
    for component in topology:
        component_bounds.append((
            Vector(tuple(min(rest_positions[index][axis] for index in component) for axis in range(3))),
            Vector(tuple(max(rest_positions[index][axis] for index in component) for axis in range(3))),
        ))
    def component_scores(component):
        scores={}
        for index in component:
            for assignment in mesh.data.vertices[index].groups:
                name=mesh.vertex_groups[assignment.group].name
                scores[name]=scores.get(name,0.0)+assignment.weight
        return scores
    component_weight_scores=[component_scores(component) for component in topology]
    owners=[max(scores,key=scores.get) if scores else None for scores in component_weight_scores]
    neighbor_links=[[] for _ in topology]
    if len(topology)>1:
        for i,(imin,imax) in enumerate(component_bounds):
            nearest=[]
            for j,(jmin,jmax) in enumerate(component_bounds):
                if i==j:
                    continue
                gap_sq=sum(max(jmin[axis]-imax[axis],imin[axis]-jmax[axis],0.0)**2 for axis in range(3))
                center_sq=(rest_centroids[i]-rest_centroids[j]).length_squared
                candidate=(center_sq,gap_sq,j)
                if len(nearest)<12:
                    nearest.append(candidate); nearest.sort()
                elif candidate<nearest[-1]:
                    nearest[-1]=candidate; nearest.sort()
            neighbor_links[i]=[(j,(rest_centroids[i]-rest_centroids[j]).length) for _,_,j in nearest]
    unanchored_components=sum(1 for links in neighbor_links if not links)
    singleton_component_exemption=len(topology)==1 and unanchored_components==1
    checks['geometric_neighbor_coverage']=(unanchored_components==0 or singleton_component_exemption)
    surface_neighbor_pairs=[]; traversed_contact_pairs=[]; negative_control_pairs=[]
    corrected_contact_seeds=[]; corrected_contact_cluster=[]; misowned_distal_arm_components=[]
    if 'surface_neighbor_diag' in gate:
        vertex_component=[-1]*len(rest_positions)
        for component_index,component in enumerate(topology):
            for vertex_index in component:
                vertex_component[vertex_index]=component_index
        tree=KDTree(len(rest_positions))
        for vertex_index,position in enumerate(rest_positions):
            tree.insert(position,vertex_index)
        tree.balance()
        search_distance=gate['surface_neighbor_search_diag']*diag
        closest_by_component_pair={}
        for a,position in enumerate(rest_positions):
            component_a=vertex_component[a]
            for _,b,distance in tree.find_range(position,search_distance):
                component_b=vertex_component[b]
                if component_a==component_b:
                    continue
                component_pair=tuple(sorted((component_a,component_b)))
                candidate=(distance,a,b,component_a,component_b)
                if component_pair not in closest_by_component_pair or candidate<closest_by_component_pair[component_pair]:
                    closest_by_component_pair[component_pair]=candidate
        contact_adjacency=[set() for _ in topology]
        for _,_,_,component_a,component_b in closest_by_component_pair.values():
            contact_adjacency[component_a].add(component_b); contact_adjacency[component_b].add(component_a)
        def segment_distance_sq(point,bone_name):
            bone=arm.data.bones[bone_name]
            start=arm.matrix_world@bone.head_local; end=arm.matrix_world@bone.tail_local; axis=end-start
            factor=0.0 if axis.length_squared<1e-12 else max(0.0,min(1.0,(point-start).dot(axis)/axis.length_squared))
            return (point-(start+factor*axis)).length_squared
        def segment_factor(point,bone_name):
            bone=arm.data.bones[bone_name]
            start=arm.matrix_world@bone.head_local; end=arm.matrix_world@bone.tail_local; axis=end-start
            return 0.0 if axis.length_squared<1e-12 else (point-start).dot(axis)/axis.length_squared
        corrected_contact_seeds=[
            component_index for component_index,center in enumerate(rest_centroids)
            if owners[component_index]=='Chest'
            and min(segment_distance_sq(center,'UpperArm.L'),segment_distance_sq(center,'UpperArm.R'))<segment_distance_sq(center,'Chest')
            and contact_adjacency[component_index]
        ]
        allowed={'Chest','UpperArm.L','UpperArm.R','Forearm.L','Forearm.R','Hand.L','Hand.R'}
        cluster=set(corrected_contact_seeds); frontier=list(corrected_contact_seeds)
        while frontier:
            component_index=frontier.pop()
            for neighbor in contact_adjacency[component_index]:
                if owners[neighbor] in allowed and neighbor not in cluster:
                    cluster.add(neighbor); frontier.append(neighbor)
        corrected_contact_cluster=sorted(cluster)
        traversed_contact_pairs=[
            candidate for candidate in closest_by_component_pair.values()
            if candidate[3] in cluster and candidate[4] in cluster
        ]
        surface_neighbor_pairs=[(a,b,distance,component_a,component_b)
                                for distance,a,b,component_a,component_b in traversed_contact_pairs]
        limb_owners=allowed-{'Chest'}
        for distance,a,b,component_a,component_b in traversed_contact_pairs:
            owner_a=owners[component_a]; owner_b=owners[component_b]
            cross_owner=owner_a!=owner_b
            if owner_a=='Chest' and owner_b in limb_owners:
                simulated,other=a,b
                component_simulated,component_other=component_a,component_b
                bone_name=owner_b
            elif owner_b=='Chest' and owner_a in limb_owners:
                simulated,other=b,a
                component_simulated,component_other=component_b,component_a
                bone_name=owner_a
            else:
                simulated,other=a,b
                component_simulated,component_other=component_a,component_b
                if owner_a in limb_owners:
                    bone_name=owner_a
                else:
                    center=rest_centroids[component_simulated]
                    bone_name=min(('UpperArm.L','UpperArm.R'),key=lambda name:segment_distance_sq(center,name))
            negative_control_pairs.append((simulated,other,component_simulated,component_other,bone_name,cross_owner))
        cross_owner_negative_control_pair_count=sum(pair[5] for pair in negative_control_pairs)
        width=max(pmax.x-pmin.x,1e-9); center_x=(pmin.x+pmax.x)*0.5
        for component_index in sorted(cluster):
            center=rest_centroids[component_index]
            scores=component_weight_scores[component_index]
            total_weight=sum(scores.values())
            limb_weight=sum(scores.get(name,0.0) for name in limb_owners)
            limb_fraction=limb_weight/total_weight if total_weight else 0.0
            if (owners[component_index]=='Chest'
                    and abs(center.x-center_x)/width>0.30
                    and any(owners[neighbor] in limb_owners for neighbor in contact_adjacency[component_index])):
                bone_name=min(('UpperArm.L','UpperArm.R'),key=lambda name:segment_distance_sq(center,name))
                factor=segment_factor(center,bone_name)
                # A smooth transition may be Chest-dominant while still carrying
                # substantial arm-chain influence. The rejected historical
                # assignment was rigid Chest (zero arm influence), which this
                # threshold explicitly detects.
                if factor>0.35 and limb_fraction<0.25:
                    misowned_distal_arm_components.append({
                        'component':component_index,'vertices':len(topology[component_index]),
                        'owner':owners[component_index],'nearest_upper_arm':bone_name,
                        'upper_arm_factor':factor,'arm_chain_weight_fraction':limb_fraction,
                    })
        checks['distal_arm_surface_ownership']=not misowned_distal_arm_components
        checks['nearest_surface_neighbor_coverage']=len(surface_neighbor_pairs)>0
        checks['old_owner_negative_control_coverage']=len(negative_control_pairs)>0
    waist_audit=[]
    if asset=='boss_knight':
        width=max(pmax.x-pmin.x,1e-9); height=max(pmax.z-pmin.z,1e-9); center_x=(pmin.x+pmax.x)*0.5
        for i,component in enumerate(topology):
            center=rest_centroids[i]; nx=(center.x-center_x)/width; nz=(center.z-pmin.z)/height
            if 150<=len(component)<=220 and 0.12<abs(nx)<0.21 and 0.22<nz<0.31:
                waist_audit.append({'component':i,'vertices':len(component),'nx':round(nx,6),'nz':round(nz,6),'owner':owners[i]})
        checks['knight_waist_component_owner']=bool(waist_audit) and all(item['owner']=='Pelvis' for item in waist_audit)
    clip_results=[]
    for name in REQUIRED[asset]:
        action=actions.get(name)
        if not action:
            clip_results.append({'name':name,'present':False,'pass':False}); continue
        clip_results.append(validate_evaluated_clip(asset,mesh,arm,action,topology,rest_positions,rest_edges,neighbor_links,surface_neighbor_pairs,negative_control_pairs,diag,owners))
    checks['complete_boundary_keys']=all(c.get('boundary_keys_complete',False) for c in clip_results)
    checks['world_space_motion_clips']=all(c.get('world_motion_gate_pass',False) for c in clip_results if (asset,c.get('name')) in WORLD_MOTION_EXPECTATIONS)
    checks['evaluated_mesh_all_clips']=all(c.get('pass',False) for c in clip_results)
    proof,proof_framing=render_all_actions_proof(f'{asset}_validation',mesh,arm,REQUIRED[asset])
    proof_relative=str(proof.relative_to(ROOT)).replace('\\','/')
    checks['all_action_visual_proof']=proof.is_file()
    checks['proof_camera_containment']=proof_framing['contained']
    passed=all(checks.values())
    return {
        'source':data['source'],'runtime_glb':data['outputs']['glb'],'runtime_glb_bytes':glb.stat().st_size,
        'editable_blend':data['outputs']['blend'],'all_action_proof':data['outputs']['all_actions_proof'],
        'editable_objects':editable_object_names,
        'editable_saved_neutral_pose':editable_neutral,
        'editable_action_switch_max_bounds_delta':editable_switch_bounds_delta,
        'editable_action_switch_max_bone_invariant_delta':editable_switch_bone_delta,
        'runtime_action_switch_max_bounds_delta':runtime_switch_bounds_delta,
        'runtime_action_switch_max_bone_invariant_delta':runtime_switch_bone_delta,
        'editable_runtime_boundary_max_normalized_dimension_delta':editable_runtime_dimension_delta,
        'editable_runtime_boundary_max_normalized_center_motion_delta':editable_runtime_center_motion_delta,
        'imported':{'meshes':[o.name for o in meshes],'ignored_import_helpers':[o.name for o in imported_meshes if o not in meshes],'armatures':[o.name for o in arms],'materials':imported_material_names,'bones':[{'name':b.name,'parent':b.parent.name if b.parent else None} for b in arm.data.bones]},
        'topology_component_count':len(topology),'geometric_neighbor_linked_components':len(topology)-unanchored_components,
        'unanchored_component_count':unanchored_components,'singleton_component_exemption':singleton_component_exemption,
        'rest_edge_count_gated':len(rest_edges),'rest_edge_count_explicitly_excluded':excluded_short_edges,
        'nearest_surface_neighbor_link_count':len(surface_neighbor_pairs),
        'traversed_coincident_contact_link_count':len(traversed_contact_pairs),
        'nearest_surface_neighbor_search_distance':gate.get('surface_neighbor_search_diag',0.0)*diag,
        'corrected_contact_seed_components':corrected_contact_seeds,
        'corrected_contact_cluster_components':corrected_contact_cluster,
        'misowned_distal_arm_components':misowned_distal_arm_components,
        'old_owner_negative_control_pair_count':len(negative_control_pairs),
        'cross_owner_negative_control_pair_count':cross_owner_negative_control_pair_count if negative_control_pairs else 0,
        'rest_edge_exclusion_reason':f"rest length <= {gate['short_edge_diag']} * asset diagonal; numerically coincident vertices after compressed GLB decode only",
        'rig_gate':gate,'empty_vertex_groups':empty_vertex_groups,'keyed_deform_bone_audit':keyed_bone_audit,'knight_waist_component_audit':waist_audit,
        'clips':clip_results,'checks':checks,'proof_framing':proof_framing,
        'validation_all_actions_proof':proof_relative,'rig_strategy':data['rig_strategy'],'limitations':data['limitations'],'pass':passed,
    }

def main():
    for asset,data in MANIFEST['assets'].items():
        print('VALIDATING',asset)
        try:
            REPORT['assets'][asset]=validate(asset,data)
        except Exception as exc:
            REPORT['assets'][asset]={'pass':False,'error':str(exc),'traceback':traceback.format_exc()}
            print('VALIDATION_FAILED',asset,traceback.format_exc())
    REPORT['runtime_glb_total_bytes']=sum((ROOT/data['outputs']['glb']).stat().st_size for data in MANIFEST['assets'].values())
    REPORT['runtime_glb_budget_bytes']=8*1024*1024
    REPORT['runtime_package_size_pass']=REPORT['runtime_glb_total_bytes']<=REPORT['runtime_glb_budget_bytes']
    REPORT['overall_pass']=REPORT['runtime_package_size_pass'] and len(REPORT['assets'])==6 and all(v.get('pass') for v in REPORT['assets'].values())
    (OUT/'qa_report.json').write_text(json.dumps(REPORT,indent=2),encoding='utf-8')
    print('FINAL_VALIDATION', 'PASS' if REPORT['overall_pass'] else 'FAIL', OUT/'qa_report.json')
    if not REPORT['overall_pass']: raise SystemExit(1)
if __name__=='__main__':
    main()

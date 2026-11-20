from pathlib import Path

import bpy
import sys


output = Path(__file__).resolve().parent
texture_path = output / "棋盘.png"
animation_only = "--animation-only" in sys.argv
bpy.ops.wm.read_factory_settings(use_empty=True)

# 使用程序生成的几何、纹理和动作，便于离线复现样本
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))
cube = bpy.context.object
cube.name = "CheckerCube"
material = bpy.data.materials.new("Checker")
material.use_nodes = True
image = bpy.data.images.new("Checker", width=16, height=16, alpha=False)
colors = ((0.04, 0.55, 0.44, 1), (0.85, 0.75, 0.22, 1))
image.pixels = [channel for y in range(16) for x in range(16)
                for channel in colors[(x // 4 + y // 4) % 2]]
image.filepath_raw = str(texture_path)
image.file_format = "PNG"
if animation_only:
    image = bpy.data.images.load(str(texture_path))
else:
    image.save()
texture = material.node_tree.nodes.new("ShaderNodeTexImage")
texture.image = image
shader = material.node_tree.nodes.get("Principled BSDF")
material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
cube.data.materials.append(material)

if not animation_only:
    bpy.ops.export_scene.gltf(filepath=str(output / "静态.glb"), export_format="GLB")
    bpy.ops.export_scene.fbx(filepath=str(output / "外部贴图.fbx"), path_mode="RELATIVE")
    bpy.ops.export_scene.fbx(filepath=str(output / "内嵌贴图.fbx"), path_mode="COPY", embed_textures=True)
    # 保留 GLB 文件头并截断内容，用于验证解析失败
    (output / "损坏.glb").write_bytes((output / "静态.glb").read_bytes()[:16])

bpy.ops.object.armature_add()
rig = bpy.context.object
rig.name = "SampleRig"
bpy.ops.object.mode_set(mode="EDIT")
base_bone = rig.data.edit_bones[0]
tip_bone = rig.data.edit_bones.new("Tip")
tip_bone.head = base_bone.tail
tip_bone.tail = (0, 0, 2)
tip_bone.parent = base_bone
tip_bone.use_connect = True
bpy.ops.object.mode_set(mode="OBJECT")
bone = rig.pose.bones[0]
group = cube.vertex_groups.new(name=bone.name)
group.add(list(range(len(cube.data.vertices))), 1.0, "REPLACE")
modifier = cube.modifiers.new("SampleSkin", "ARMATURE")
modifier.object = rig
cube.parent = rig

bpy.ops.mesh.primitive_cube_add(size=0.65, location=(1.8, 0, 0.325))
marker = bpy.context.object
marker.name = "Marker"
marker.parent = rig

scene = bpy.context.scene
scene.frame_end = 25
bone.rotation_mode = "XYZ"
for name, axis, angle in [("Swing", 2, 0.75), ("Tilt", 0, 0.55)]:
    for frame, value in [(1, 0), (13, angle), (25, 0)]:
        bone.rotation_euler[axis] = value
        bone.keyframe_insert(data_path="rotation_euler", frame=frame)
    action = rig.animation_data.action
    action.name = name
    slot = rig.animation_data.action_slot
    rig.animation_data.action = None
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, action)
    strip.action_slot = slot
scene.frame_set(1)
bpy.ops.export_scene.gltf(filepath=str(output / "骨骼动画.glb"), export_format="GLB",
                          export_animation_mode="NLA_TRACKS")

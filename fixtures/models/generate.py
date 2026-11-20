from pathlib import Path

import bpy


output = Path(__file__).resolve().parent
texture_path = output / "棋盘.png"
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
image.save()
texture = material.node_tree.nodes.new("ShaderNodeTexImage")
texture.image = image
shader = material.node_tree.nodes.get("Principled BSDF")
material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
cube.data.materials.append(material)

bpy.ops.export_scene.gltf(filepath=str(output / "静态.glb"), export_format="GLB")
bpy.ops.export_scene.fbx(filepath=str(output / "外部贴图.fbx"), path_mode="RELATIVE")
bpy.ops.export_scene.fbx(filepath=str(output / "内嵌贴图.fbx"), path_mode="COPY", embed_textures=True)

bpy.ops.object.armature_add()
rig = bpy.context.object
rig.name = "SampleRig"
bone = rig.pose.bones[0]
group = cube.vertex_groups.new(name=bone.name)
group.add(list(range(len(cube.data.vertices))), 1.0, "REPLACE")
modifier = cube.modifiers.new("SampleSkin", "ARMATURE")
modifier.object = rig
cube.parent = rig

scene = bpy.context.scene
scene.frame_end = 25
bone.rotation_mode = "XYZ"
for frame, angle in [(1, 0), (13, 0.75), (25, 0)]:
    bone.rotation_euler.z = angle
    bone.keyframe_insert(data_path="rotation_euler", frame=frame)
rig.animation_data.action.name = "Swing"
scene.frame_set(1)
bpy.ops.export_scene.gltf(filepath=str(output / "骨骼动画.glb"), export_format="GLB")

# 保留 GLB 文件头并截断内容，用于验证解析失败
(output / "损坏.glb").write_bytes((output / "静态.glb").read_bytes()[:16])

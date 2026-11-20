import argparse
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile

import bpy


def add_basis_texture(source, target, encoder):
    glb = source.read_bytes()
    json_size = struct.unpack_from("<I", glb, 12)[0]
    document = json.loads(glb[20:20 + json_size])
    binary = bytearray(glb[28 + json_size:])
    with tempfile.TemporaryDirectory(prefix="viewer-basis-") as temporary:
        directory = Path(temporary)
        shutil.copyfile(source.with_name("棋盘.png"), directory / "color.png")
        subprocess.run([encoder, "-ktx2", "-mipmap", "-file", "color.png",
                        "-output_file", "color.ktx2"], cwd=directory, check=True)
        texture = (directory / "color.ktx2").read_bytes()

    document["extensionsUsed"] = document["extensionsRequired"] = ["KHR_texture_basisu"]
    document["textures"][0].pop("source")
    document["textures"][0]["extensions"] = {"KHR_texture_basisu": {"source": 0}}
    # 替换原贴图视图，保留同一网格、材质和 UV 以比较解码结果
    view_index = document["images"][0]["bufferView"]
    document["images"][0]["mimeType"] = "image/ktx2"
    document["bufferViews"][view_index] = {"buffer": 0, "byteOffset": len(binary), "byteLength": len(texture)}
    binary += texture
    binary += b"\0" * (-len(binary) % 4)
    document["buffers"][0]["byteLength"] = len(binary)
    header = json.dumps(document, separators=(",", ":")).encode()
    header += b" " * (-len(header) % 4)
    total = 28 + len(header) + len(binary)
    target.write_bytes(struct.pack("<4sIII4s", b"glTF", 2, total, len(header), b"JSON") + header
                       + struct.pack("<I4s", len(binary), b"BIN\0") + binary)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--basisu", type=Path)
    parser.add_argument("--large", type=Path)
    options = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    output = Path(__file__).resolve().parent
    static = output / "静态.glb"
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(static))
    bpy.ops.export_scene.gltf(filepath=str(output / "Draco.glb"), export_draco_mesh_compression_enable=True)
    bpy.ops.export_scene.gltf(filepath=str(output / "Meshopt.glb"), export_meshopt_compression_enable=True)
    if options.basisu:
        add_basis_texture(static, output / "KTX2.glb", str(options.basisu.resolve()))
    if options.large:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.mesh.primitive_uv_sphere_add(segments=768, ring_count=384)
        path = options.large.resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.export_scene.gltf(filepath=str(path))


if __name__ == "__main__":
    main()

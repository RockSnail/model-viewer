import copy
import json
import struct
from pathlib import Path


folder = Path(__file__).resolve().parent
source = (folder / "静态.glb").read_bytes()
json_size = struct.unpack_from("<I", source, 12)[0]
document = json.loads(source[20:20 + json_size])
binary_chunk = source[20 + json_size:]

# 叠放一块半透明网格，用同一场景核对混合和遮挡关系
glass = copy.deepcopy(document["materials"][0])
glass["name"] = "Amber blend"
glass["alphaMode"] = "BLEND"
glass["pbrMetallicRoughness"] = {"baseColorFactor": [1, 0.32, 0.08, 0.44], "roughnessFactor": 0.75}
primitive = copy.deepcopy(document["meshes"][0]["primitives"][0])
primitive["material"] = len(document["materials"])
document["materials"].append(glass)

mesh_index = len(document["meshes"])
document["meshes"].append({"name": "Amber blend", "primitives": [primitive]})
node_index = len(document["nodes"])
document["nodes"].append({"name": "Amber blend", "mesh": mesh_index, "translation": [0.55, 1.1, 0.58],
                          "scale": [0.86, 0.72, 0.86]})
document["scenes"][document.get("scene", 0)]["nodes"].append(node_index)

header = json.dumps(document, separators=(",", ":")).encode()
header += b" " * (-len(header) % 4)
size = 20 + len(header) + len(binary_chunk)
(folder / "透明材质.glb").write_bytes(struct.pack("<4sIII4s", b"glTF", 2, size, len(header), b"JSON")
                                     + header + binary_chunk)

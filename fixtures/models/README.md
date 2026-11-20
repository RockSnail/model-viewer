# 模型回归样本

模型、棋盘贴图和动画由本目录的 `generate.py` 程序生成，按 CC0 1.0 提供，可以复制、修改和重新分发。[CC0 1.0 条款](https://creativecommons.org/publicdomain/zero/1.0/)

| 文件 | 验证内容 |
| --- | --- |
| `静态.glb` | 带棋盘材质的静态立方体 |
| `内嵌贴图.fbx` | 随 FBX 保存的内嵌 PNG |
| `外部贴图.fbx`、`棋盘.png` | 相对路径贴图；可复制 FBX 到没有 PNG 的目录以验证缺失提示 |
| `骨骼动画.glb` | 蒙皮网格和一段 `Swing` 动画 |
| `损坏.glb` | 文件内容被刻意截断，预期解析失败 |

在项目根目录运行 `blender --background --python-exit-code 1 --python fixtures/models/generate.py` 可重新生成这些文件。该命令会覆盖同名样本。

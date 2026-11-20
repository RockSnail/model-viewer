# 模型回归样本

模型、棋盘贴图和动画由本目录的 `generate.py` 程序生成，按 CC0 1.0 提供，可以复制、修改和重新分发。[CC0 1.0 条款](https://creativecommons.org/publicdomain/zero/1.0/)

| 文件 | 验证内容 |
| --- | --- |
| `静态.glb` | 带棋盘材质的静态立方体 |
| `内嵌贴图.fbx` | 随 FBX 保存的内嵌 PNG |
| `外部贴图.fbx`、`棋盘.png` | 相对路径贴图；可复制 FBX 到没有 PNG 的目录以验证缺失提示 |
| `骨骼动画.glb` | 两个可独显部件、两根骨骼及 `Swing`、`Tilt` 两个动画片段 |
| `Draco.glb` | `KHR_draco_mesh_compression` 几何压缩 |
| `Meshopt.glb` | `EXT_meshopt_compression` 缓冲压缩 |
| `KTX2.glb` | `KHR_texture_basisu` 内嵌 ETC1S KTX2 贴图 |
| `透明材质.glb` | 叠放的棋盘网格和半透明琥珀色网格，用于对比后端混合与遮挡 |
| `损坏.glb` | 文件内容被刻意截断，预期解析失败 |

在项目根目录运行 `blender --background --python-exit-code 1 --python fixtures/models/generate.py` 可重新生成基础模型、棋盘贴图和损坏样本。该命令会覆盖同名样本。

压缩样本以 `静态.glb` 为源。下面的命令会覆盖相应的压缩样本，并生成不提交到仓库的大模型测试文件。`--basisu` 指向本地 Basis Universal 可执行文件，用于生成 `KTX2.glb`。

```powershell
blender --background --python-exit-code 1 --python fixtures/models/generate_release_samples.py -- --basisu 'C:/工具/basisu.exe' --large 'src-tauri/target/qa/Large.glb'
```

运行 `python fixtures/models/generate_transparency_sample.py` 可从 `静态.glb` 重新生成透明材质样本。

# 模型预览

Windows 本地 GLB、FBX 模型查看器，使用 Tauri、Vue 3 和 Three.js。可检查场景树、材质、纹理、UV0 和骨骼，播放动画，并对两个表面点测距。

## 开发与构建

- `pnpm install` 安装依赖，`pnpm tauri dev` 启动开发窗口。
- `pnpm tauri build` 生成免安装版 `src-tauri/target/release/model-viewer.exe`。目标电脑安装 Microsoft Edge WebView2 Runtime 后，双击 EXE 即可离线查看模型。
- 常用快捷键为 `Ctrl+O` 打开、`Ctrl+R` 重载、`Ctrl+S` 截图、`F11` 全屏、`Esc` 退出全屏。
- GLB 支持 Draco、Meshopt 和 KTX2/Basis，解码资源内嵌在 EXE 中。已验收样本见 [模型回归样本](fixtures/models/README.md)。
- 顶栏可选择「自动」「WebGPU」或「WebGL 2」，底栏显示实际后端。「自动」优先尝试 WebGPU，初始化失败时回退到 WebGL 2。切换实际后端会重新载入当前模型，以便按目标设备的能力解码贴图。

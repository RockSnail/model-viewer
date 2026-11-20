import { PMREMGenerator, WebGLRenderer, WebGPUCoordinateSystem, type RenderTarget } from "three";
import type { WebGPURenderer } from "three/webgpu";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export type Renderer = WebGLRenderer | WebGPURenderer;
export type Backend = "webgpu" | "webgl";
export type BackendPreference = Backend | "auto";

export type RenderEngine = {
  backend: Backend;
  renderer: Renderer;
  environment: () => RenderTarget;
  onLost: (callback: (reason: string) => void) => void;
  dispose: () => void;
};

function environmentFrom(generator: { fromScene: (scene: RoomEnvironment, sigma: number) => RenderTarget; dispose: () => void }) {
  const room = new RoomEnvironment();
  try {
    return generator.fromScene(room, 0.04);
  } finally {
    room.dispose();
    generator.dispose();
  }
}

export async function createRenderEngine(backend: Backend): Promise<RenderEngine> {
  if (backend === "webgl") {
    const renderer = new WebGLRenderer({ antialias: true });
    return {
      backend,
      renderer,
      environment: () => environmentFrom(new PMREMGenerator(renderer)),
      onLost: () => {},
      dispose: () => {
        renderer.dispose();
        renderer.forceContextLoss();
      },
    };
  }

  if (!navigator.gpu) throw new Error("当前 WebView2 未提供 WebGPU");
  const { PMREMGenerator: GPUPMREMGenerator, WebGPURenderer } = await import("three/webgpu");
  const renderer = new WebGPURenderer({ antialias: true });
  const dispose = () => {
    // 主动销毁设备时不触发应用层回退
    renderer.onDeviceLost = () => {};
    void Promise.resolve(renderer.dispose()).catch(console.error);
  };
  try {
    await renderer.init();
    // Three.js 可能在内部回退，实际后端以初始化后的坐标系为准
    if (renderer.coordinateSystem !== WebGPUCoordinateSystem) {
      throw new Error("WebGPU 设备初始化失败，可能没有可用的适配器或驱动");
    }
  } catch (error) {
    if (renderer.initialized) dispose();
    throw error;
  }

  return {
    backend,
    renderer,
    environment: () => environmentFrom(new GPUPMREMGenerator(renderer)),
    onLost: (callback) => {
      const markLost = renderer.onDeviceLost.bind(renderer);
      renderer.onDeviceLost = (info) => {
        markLost(info);
        callback(info.message || "WebGPU 设备连接中断");
      };
    },
    dispose,
  };
}

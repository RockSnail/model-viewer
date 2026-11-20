import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { LoadingManager, Mesh, Skeleton, Texture, type AnimationClip, type Material, type Object3D } from "three";
import type { Renderer } from "./renderer";

export type Model = {
  root: Object3D;
  animations: AnimationClip[];
  missingTextures: string[];
  bytes: number;
  dispose: () => void;
};

export function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export function isModelPath(path: string) {
  return /\.(glb|fbx)$/i.test(path);
}

export async function loadModel(path: string, renderer: Renderer, folder?: string): Promise<Model> {
  let bytes: ArrayBuffer;
  try {
    bytes = await invoke<ArrayBuffer>("read_model", { path });
  } catch (error) {
    throw Object.assign(new Error(`无法读取「${fileName(path)}」`), { cause: error });
  }

  const manager = new LoadingManager();
  const missing = new Set<string>();
  const blobUrls = new Set<string>();
  const resources = new Map<string, string>();
  const endpoint = convertFileSrc("resource", "model-resource");
  const complete = new Promise<void>((resolve) => { manager.onLoad = resolve; });

  manager.setURLModifier((url) => {
    if (url.startsWith("blob:")) blobUrls.add(url);
    if (/^(blob:|data:)/i.test(url)) return url;

    let resource = url;
    try { resource = decodeURIComponent(url); } catch { /* 保留文件名中的原始百分号 */ }
    const query = new URLSearchParams({ model: path, resource, ...(folder ? { folder } : {}) });
    const localUrl = `${endpoint}?${query}`;
    resources.set(localUrl, fileName(resource));
    return localUrl;
  });

  manager.onError = (url) => {
    const name = resources.get(url);
    if (name && !/\.bin$/i.test(name)) missing.add(name);
  };

  // 解析本身也计入加载，避免贴图回调先结束或无贴图时遗漏完成信号
  manager.itemStart(path);
  let root: Object3D;
  let animations: AnimationClip[];
  let scenes: Object3D[];
  try {
    if (/\.fbx$/i.test(path)) {
      const [{ FBXLoader }, { TGALoader }] = await Promise.all([
        import("three/addons/loaders/FBXLoader.js"),
        import("three/addons/loaders/TGALoader.js"),
      ]);
      manager.addHandler(/\.tga$/i, new TGALoader(manager));
      root = new FBXLoader(manager).parse(bytes, "");
      animations = root.animations;
      scenes = [root];
    } else {
      const { decodeGLB } = await import("./compressed");
      const gltf = await decodeGLB(bytes, manager, renderer);
      root = gltf.scene;
      animations = gltf.animations;
      scenes = gltf.scenes;
    }
  } catch (error) {
    throw Object.assign(new Error(`无法解析「${fileName(path)}」`), { cause: error });
  } finally {
    manager.itemEnd(path);
    await complete;
    for (const url of blobUrls) URL.revokeObjectURL(url);
  }

  return { root, animations, missingTextures: [...missing], bytes: bytes.byteLength, dispose: () => disposeScenes(scenes) };
}

function disposeScenes(scenes: Object3D[]) {
  const geometries = new Set<Mesh["geometry"]>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const skeletons = new Set<Skeleton>();
  const bitmaps = new Set<ImageBitmap>();

  for (const scene of scenes) {
    scene.traverse((object) => {
      const renderable = object as Partial<Mesh & { skeleton: Skeleton }>;
      if (renderable.geometry) geometries.add(renderable.geometry);
      if (renderable.skeleton) skeletons.add(renderable.skeleton);
      if (Array.isArray(renderable.material)) renderable.material.forEach((material) => materials.add(material));
      else if (renderable.material) materials.add(renderable.material);
    });
  }

  // FBX 和 GLB 节点可能共享资源，每项只释放一次
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof Texture) textures.add(value);
    }
    material.dispose();
  }
  for (const texture of textures) {
    if (texture.source.data instanceof ImageBitmap) bitmaps.add(texture.source.data);
    texture.dispose();
  }
  for (const bitmap of bitmaps) bitmap.close();
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}

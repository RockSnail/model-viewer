import { LoadingManager } from "three";
import type { Renderer } from "./renderer";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import dracoJS from "three/addons/libs/draco/gltf/draco_wasm_wrapper.js?url&no-inline";
import dracoWasm from "three/addons/libs/draco/gltf/draco_decoder.wasm?url&no-inline";
import basisJS from "three/addons/libs/basis/basis_transcoder.js?url&no-inline";
import basisWasm from "three/addons/libs/basis/basis_transcoder.wasm?url&no-inline";

export async function decodeGLB(bytes: ArrayBuffer, modelAssets: LoadingManager, renderer: Renderer) {
  const draco = new DRACOLoader().setDecoderPath({ js: dracoJS, wasm: dracoWasm }).setWorkerLimit(2);
  const textures = new LoadingManager();
  // 转码器从安装包同源加载，外部模型贴图沿用已授权的本地资源协议
  textures.setURLModifier((url) => {
    if (url === "./viewer-codecs/basis_transcoder.js") return basisJS;
    if (url === "./viewer-codecs/basis_transcoder.wasm") return basisWasm;
    return modelAssets.resolveURL(url);
  });
  textures.onError = (url) => modelAssets.onError?.(url);
  const ktx2 = new KTX2Loader(textures).setTranscoderPath("./viewer-codecs/").setWorkerLimit(2).detectSupport(renderer);
  try {
    return await new GLTFLoader(modelAssets)
      .setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2)
      .parseAsync(bytes, "");
  } finally {
    draco.dispose();
    if (ktx2.transcoderPending) ktx2.dispose();
  }
}

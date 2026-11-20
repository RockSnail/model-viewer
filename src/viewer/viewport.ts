import {
  AxesHelper,
  Bone,
  Box3,
  Box3Helper,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  GridHelper,
  HemisphereLight,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Matrix4,
  NoToneMapping,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SkeletonHelper,
  SkinnedMesh,
  Sphere,
  SphereGeometry,
  SRGBColorSpace,
  TorusKnotGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  ACESFilmicToneMapping,
  type Material,
  type Object3D,
  type Texture,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { inspectMaterials, isRenderable, type DisplayMode } from "./inspection";
import { createPlayback } from "./playback";
import type { Model } from "./model";
import type { RenderEngine, Renderer } from "./renderer";

const homeDirection = new Vector3(4.8, 2.45, 6.2);
const fixedDirections = {
  front: new Vector3(0, 0, 1),
  side: new Vector3(1, 0, 0),
  top: new Vector3(0, 1, 0.00001),
};

export function createViewport(host: HTMLElement, engine: RenderEngine, callbacks: {
  select: (id?: string) => void;
  playback: (time: number, playing: boolean) => void;
  measure: (distance?: number, hasPoint?: boolean) => void;
}) {
  const { renderer } = engine;
  renderer.setClearColor(new Color("#171e27"));
  host.append(renderer.domElement);

  const scene = new Scene();
  const defaultFov = 42;
  const perspective = new PerspectiveCamera(defaultFov, 1, 0.05, 100);
  const orthographic = new OrthographicCamera(-1, 1, 1, -1, 0.05, 100);
  let camera: PerspectiveCamera | OrthographicCamera = perspective;
  let orthoHeight = 6;
  camera.position.set(4.8, 3.5, 6.2);
  const controls = new OrbitControls<PerspectiveCamera | OrthographicCamera>(camera, renderer.domElement);
  controls.target.set(0, 1.05, 0);
  controls.minDistance = 1;
  controls.maxDistance = 22;
  controls.update();
  controls.saveState();

  const grid = new GridHelper(20, 40, 0x526478, 0x303d4d);
  const axes = new AxesHelper(2.4);
  axes.position.y = 0.01;
  const keyLight = new DirectionalLight(0xe4f5ff, 3);
  keyLight.position.set(3, 6, 4);
  const rimLight = new DirectionalLight(0x78aaff, 1.8);
  rimLight.position.set(-4, 3, -3);
  scene.add(grid, axes, keyLight, rimLight, new HemisphereLight(0xe7f4ff, 0x445066, 1.55));

  const sample = new Mesh(
    new TorusKnotGeometry(0.95, 0.27, 160, 24),
    new MeshStandardMaterial({ color: 0x259e90, metalness: 0.22, roughness: 0.34 }),
  );
  sample.position.y = 1.32;
  scene.add(sample);

  let frame: number | undefined;
  let model: Object3D | undefined;
  let selected: Object3D | undefined;
  let playback: ReturnType<typeof createPlayback> | undefined;
  let skeleton: SkeletonHelper | undefined;
  let joints: InstancedMesh | undefined;
  const bones: Bone[] = [];
  const pickable: Object3D[] = [];
  const originalMaterials = new Map<Mesh, Material | Material[]>();
  const originalVisibility = new Map<Object3D, { visible: boolean; layers: number }>();
  const solid = new MeshStandardMaterial({ color: 0xb3c2cb, roughness: 0.85 });
  const wireframe = new MeshBasicMaterial({ color: 0x9fe9da, wireframe: true });
  const selectionBox = new Box3();
  const outline = new Box3Helper(selectionBox, 0x9ff8d9);
  if (!Array.isArray(outline.material)) outline.material.depthTest = false;
  outline.renderOrder = 10;
  outline.visible = false;
  scene.add(outline);
  let environment: RenderTarget | undefined;
  const measurePoints: Vector3[] = [];
  const measureGeometry = new BufferGeometry();
  measureGeometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
  const markerGeometry = new SphereGeometry(1, 8, 6);
  const markerMaterial = new MeshBasicMaterial({ color: 0xffc471, depthTest: false });
  const markerTransform = new Matrix4();
  const markerPosition = new Vector3();
  const measurement = new InstancedMesh(markerGeometry, markerMaterial, 2);
  const measurementLine = new Line(measureGeometry, new LineBasicMaterial({ color: 0xffc471, depthTest: false }));
  measurement.frustumCulled = measurementLine.frustumCulled = false;
  measurement.renderOrder = measurementLine.renderOrder = 20;
  measurement.visible = measurementLine.visible = false;
  scene.add(measurement, measurementLine);
  let measuring = false;
  let benchmark: { intervals: number[]; previous?: number; done: (result: ViewMetrics) => void } | undefined;

  function updateMarkers(markers: InstancedMesh, size: number, positionAt: (index: number) => Vector3) {
    // WebGPU 的原生点为 1 像素，使用实例化球体保持两种后端的标记可见
    const height = Math.max(1, host.clientHeight);
    const span = camera === orthographic ? 2 * orthographic.top / orthographic.zoom
      : 2 * controls.target.distanceTo(camera.position) * Math.tan(perspective.fov * Math.PI / 360);
    const radius = span * size / (2 * height);
    for (let index = 0; index < markers.count; index++) {
      markerTransform.makeScale(radius, radius, radius).setPosition(positionAt(index));
      markers.setMatrixAt(index, markerTransform);
    }
    markers.instanceMatrix.needsUpdate = true;
  }

  function clearMeasure() {
    measurePoints.length = 0;
    measurement.visible = measurementLine.visible = false;
    callbacks.measure();
    scheduleRender();
  }

  function measureAt(point: Vector3) {
    if (measurePoints.length === 2) measurePoints.length = 0;
    measurePoints.push(point.clone());
    const positions = measureGeometry.getAttribute("position");
    measurePoints.forEach((value, index) => positions.setXYZ(index, value.x, value.y, value.z));
    positions.needsUpdate = true;
    measureGeometry.setDrawRange(0, measurePoints.length);
    measurement.count = measurePoints.length;
    measurement.visible = true;
    measurementLine.visible = measurePoints.length === 2;
    callbacks.measure(measurementLine.visible ? measurePoints[0].distanceTo(measurePoints[1]) : undefined, true);
    scheduleRender();
  }

  function setDisplayMode(mode: DisplayMode) {
    for (const [mesh, original] of originalMaterials) {
      mesh.material = mode === "original" ? original : mode === "solid" ? solid : wireframe;
    }
    scheduleRender();
  }

  function setSkeletonVisible(visible: boolean) {
    if (visible && model && bones.length && !skeleton) {
      skeleton = new SkeletonHelper(model);
      if (!Array.isArray(skeleton.material)) skeleton.material.depthTest = false;
      skeleton.renderOrder = 11;
      joints = new InstancedMesh(markerGeometry, markerMaterial, bones.length);
      joints.frustumCulled = false;
      joints.renderOrder = 12;
      scene.add(skeleton, joints);
    }
    if (skeleton) skeleton.visible = visible;
    if (joints) joints.visible = visible;
    scheduleRender();
  }

  function resetInspection() {
    measuring = false;
    clearMeasure();
    playback?.dispose();
    playback = undefined;
    selected = undefined;
    outline.visible = false;
    if (skeleton) {
      scene.remove(skeleton);
      skeleton.dispose();
      skeleton = undefined;
    }
    if (joints) {
      scene.remove(joints);
      joints.dispose();
      joints = undefined;
    }
    bones.length = 0;
    pickable.length = 0;
    // 恢复源材质后再由加载层释放，避免误释放共用的预览材质
    setDisplayMode("original");
    originalMaterials.clear();
    for (const [object, original] of originalVisibility) {
      object.visible = original.visible;
      object.layers.mask = original.layers;
    }
    originalVisibility.clear();
  }

  function setVisibility(overrides: ReadonlyMap<string, boolean>, isolated?: Object3D) {
    const branch = new Set<Object3D>();
    const ancestors = new Set<Object3D>();
    isolated?.traverse((object) => branch.add(object));
    for (let parent = isolated?.parent; parent && originalVisibility.has(parent); parent = parent.parent) {
      ancestors.add(parent);
    }
    for (const [object, original] of originalVisibility) {
      const onPath = object === isolated || ancestors.has(object);
      object.visible = onPath || ((!isolated || branch.has(object)) && (overrides.get(object.uuid) ?? original.visible));
      // 父级网格可以包含子部件，独显时保留父级变换但跳过父级绘制
      object.layers.mask = ancestors.has(object) ? 0 : original.layers;
    }
    const visible = new Set<string>();
    model?.traverseVisible((object) => { if (object.layers.mask) visible.add(object.uuid); });
    scheduleRender();
    return visible;
  }

  function fit(direction: Vector3, target = model ?? sample, initialBounds?: Box3) {
    const bounds = initialBounds ?? new Box3().setFromObject(target);
    if (bounds.isEmpty() && target !== model && model) bounds.setFromObject(model, true);
    const sphere = bounds.getBoundingSphere(new Sphere());
    const radius = Math.max(sphere.radius, 0.0001);
    const offset = radius * 1.15 / Math.sin(defaultFov * Math.PI / 360);

    // 裁剪距离和操作范围随模型尺寸调整，源模型保留原始坐标与单位
    camera.near = radius / 1000;
    camera.far = radius * 100;
    if (camera === orthographic) {
      orthoHeight = radius * 2.4;
      orthographic.zoom = 1;
    }
    resize();
    controls.minDistance = radius * 0.05;
    controls.maxDistance = radius * 40;
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(direction.clone().normalize(), offset);
    controls.update();
    scheduleRender();
  }

  // 静止时不持续绘制，同一帧内的多次变化合并处理
  function scheduleRender() {
    if (frame !== undefined) return;
    frame = requestAnimationFrame((timestamp) => {
      frame = undefined;
      const playing = playback?.update(timestamp);
      if (selected || joints?.visible) model?.updateMatrixWorld();
      if (selected) {
        selectionBox.setFromObject(selected);
        if (selectionBox.isEmpty()) {
          const point = new Vector3().setFromMatrixPosition(selected.matrixWorld);
          const radius = controls.target.distanceTo(camera.position) * 0.012;
          selectionBox.setFromCenterAndSize(point, new Vector3().setScalar(radius));
        }
        outline.visible = isVisible(selected);
      }
      if (joints?.visible) {
        updateMarkers(joints, 6, (index) => markerPosition.setFromMatrixPosition(bones[index].matrixWorld));
      }
      if (measurement.visible) updateMarkers(measurement, 8, (index) => measurePoints[index]);
      renderer.render(scene, camera);
      if (benchmark) {
        if (benchmark.previous !== undefined) benchmark.intervals.push(timestamp - benchmark.previous);
        benchmark.previous = timestamp;
        if (benchmark.intervals.length >= 45) finishBenchmark();
      }
      if (playing || benchmark) scheduleRender();
    });
  }

  function isVisible(object: Object3D) {
    if (!object.layers.test(camera.layers)) return false;
    for (let parent: Object3D | null = object; parent; parent = parent.parent) {
      if (!parent.visible) return false;
    }
    return true;
  }

  const raycaster = new Raycaster();
  const canvas = renderer.domElement;
  let pointer: { id: number; x: number; y: number; moved: boolean } | undefined;
  function beginPick(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  }
  function movePick(event: PointerEvent) {
    if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) {
      pointer.moved = true;
    }
  }
  function cancelPick() { pointer = undefined; }
  function finishPick(event: PointerEvent) {
    movePick(event);
    const click = pointer?.id === event.pointerId && !pointer.moved;
    cancelPick();
    if (!click || !model || event.button !== 0) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    camera.updateMatrixWorld();
    model.updateWorldMatrix(true, true);
    raycaster.setFromCamera(new Vector2(
      2 * (event.clientX - bounds.left) / bounds.width - 1,
      1 - 2 * (event.clientY - bounds.top) / bounds.height,
    ), camera);
    const candidates = pickable.filter(isVisible);
    const span = camera === orthographic ? orthoHeight / orthographic.zoom
      : 2 * controls.target.distanceTo(camera.position) * Math.tan(perspective.fov * Math.PI / 360);
    const hitTolerance = span * 4 / bounds.height;
    raycaster.params.Line = { threshold: hitTolerance };
    raycaster.params.Points = { threshold: hitTolerance };
    for (const mesh of candidates) {
      // 蒙皮顶点可能已经离开初始姿势的拾取范围
      if (mesh instanceof SkinnedMesh) {
        mesh.computeBoundingSphere();
        if (mesh.boundingBox) mesh.computeBoundingBox();
      }
    }
    const hit = raycaster.intersectObjects(candidates, false)[0];
    if (measuring) {
      if (hit) measureAt(hit.point);
    } else {
      callbacks.select(hit?.object.uuid);
    }
  }
  canvas.addEventListener("pointerdown", beginPick);
  canvas.addEventListener("pointermove", movePick);
  canvas.addEventListener("pointerup", finishPick);
  canvas.addEventListener("pointercancel", cancelPick);

  function resize() {
    const { clientWidth: width, clientHeight: height } = host;
    if (!width || !height) return;
    perspective.aspect = width / height;
    // 窄窗口保留初始水平视野，避免测试模型被两侧裁切
    const halfFov = defaultFov * Math.PI / 360;
    const narrowFov = 2 * Math.atan(Math.tan(halfFov) / perspective.aspect);
    perspective.fov = Math.max(defaultFov, narrowFov * 180 / Math.PI);
    perspective.updateProjectionMatrix();
    const heightSpan = orthoHeight / Math.min(perspective.aspect, 1);
    orthographic.top = heightSpan / 2;
    orthographic.bottom = -orthographic.top;
    orthographic.right = orthographic.top * perspective.aspect;
    orthographic.left = -orthographic.right;
    orthographic.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    scheduleRender();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(host);
  controls.addEventListener("change", scheduleRender);
  resize();

  function finishBenchmark() {
    if (!benchmark) return;
    const { intervals, done } = benchmark;
    benchmark = undefined;
    const sorted = [...intervals].sort((a, b) => a - b);
    done({
      median: sorted[Math.floor(sorted.length / 2)] ?? 0,
      p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
    });
  }

  return {
    renderer,
    setModel(next?: Model, initialBounds?: Box3) {
      finishBenchmark();
      resetInspection();
      if (model) scene.remove(model);
      model = next?.root;
      if (model) {
        scene.add(model);
        model.traverse((object) => {
          originalVisibility.set(object, { visible: object.visible, layers: object.layers.mask });
          if (object instanceof Mesh) originalMaterials.set(object, object.material);
          if (isRenderable(object)) pickable.push(object);
          if (object instanceof Bone) bones.push(object);
        });
        if (next?.animations.length) playback = createPlayback(model, callbacks.playback);
        const bounds = initialBounds ?? new Box3().setFromObject(model);
        const scale = Math.max(bounds.getSize(new Vector3()).length() / 4, 0.0001);
        const center = bounds.getCenter(new Vector3());
        grid.position.set(center.x, bounds.isEmpty() ? 0 : bounds.min.y, center.z);
        grid.scale.setScalar(scale);
        axes.scale.setScalar(scale);
        fit(homeDirection, model, bounds);
      } else {
        grid.position.set(0, 0, 0);
        grid.scale.setScalar(1);
        axes.scale.setScalar(1);
        controls.minDistance = 1;
        controls.maxDistance = 22;
        camera.near = 0.05;
        camera.far = 100;
        camera.updateProjectionMatrix();
        controls.reset();
      }
      scheduleRender();
    },
    setSampleVisible(visible: boolean) {
      sample.visible = visible;
      scheduleRender();
    },
    resetView() {
      if (model) fit(homeDirection);
      else controls.reset();
    },
    focus() {
      fit(camera.position.clone().sub(controls.target), selected ?? model ?? sample);
    },
    setView(view: keyof typeof fixedDirections) {
      fit(fixedDirections[view]);
    },
    setGridVisible(visible: boolean) {
      grid.visible = visible;
      scheduleRender();
    },
    setAxesVisible(visible: boolean) {
      axes.visible = visible;
      scheduleRender();
    },
    select(object?: Object3D) {
      selected = object;
      outline.visible = false;
      scheduleRender();
    },
    materials(object?: Object3D) { return inspectMaterials(object, originalMaterials); },
    setVisibility,
    setDisplayMode,
    setSkeletonVisible,
    selectClip(clip: Model["animations"][number]) { playback?.select(clip); scheduleRender(); },
    seek(time: number) { playback?.seek(time); scheduleRender(); },
    setPlaying(value: boolean) { playback?.setPlaying(value); scheduleRender(); },
    setLoop(value: boolean) { playback?.setLoop(value); },
    setProjection(value: "perspective" | "orthographic") {
      const next = value === "orthographic" ? orthographic : perspective;
      if (next === camera) return;
      const distance = camera.position.distanceTo(controls.target);
      if (next === orthographic) {
        orthoHeight = 2 * distance * Math.tan(defaultFov * Math.PI / 360);
        orthographic.zoom = 1;
      }
      next.position.copy(camera.position);
      next.near = camera.near;
      next.far = camera.far;
      camera = next;
      controls.object = next;
      resize();
      controls.update();
    },
    setLighting(studio: boolean, exposure: number) {
      if (studio && !environment) {
        environment = engine.environment();
      }
      scene.environment = studio && environment ? environment.texture : null;
      renderer.toneMapping = studio || exposure !== 0 ? ACESFilmicToneMapping : NoToneMapping;
      renderer.toneMappingExposure = 2 ** exposure;
      scheduleRender();
    },
    setMeasuring(active: boolean) {
      measuring = active;
      clearMeasure();
    },
    capture() {
      renderer.render(scene, camera);
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法生成 PNG")), "image/png");
      });
    },
    previewTexture(texture: Texture) { return texturePreview(renderer, texture); },
    sampleFrames() {
      if (benchmark) finishBenchmark();
      return new Promise<ViewMetrics>((done) => {
        benchmark = { intervals: [], done };
        scheduleRender();
      });
    },
    dispose() {
      // 先停止重绘和输入，再释放视口持有的 GPU 资源
      observer.disconnect();
      controls.removeEventListener("change", scheduleRender);
      controls.dispose();
      canvas.removeEventListener("pointerdown", beginPick);
      canvas.removeEventListener("pointermove", movePick);
      canvas.removeEventListener("pointerup", finishPick);
      canvas.removeEventListener("pointercancel", cancelPick);
      resetInspection();
      finishBenchmark();
      if (frame !== undefined) cancelAnimationFrame(frame);
      outline.dispose();
      solid.dispose();
      wireframe.dispose();
      environment?.dispose();
      measureGeometry.dispose();
      measurement.dispose();
      markerGeometry.dispose();
      markerMaterial.dispose();
      measurementLine.material.dispose();
      sample.geometry.dispose();
      sample.material.dispose();
      grid.dispose();
      axes.dispose();
      engine.dispose();
      renderer.domElement.remove();
    },
  };
}

export type ViewMetrics = { median: number; p95: number; geometries: number; textures: number };

async function texturePreview(renderer: Renderer, texture: Texture) {
  const image = texture.image as { width?: number; height?: number } | undefined;
  if (!image?.width || !image?.height) return undefined;
  const scale = Math.min(1, 192 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const gl = renderer instanceof WebGLRenderer;
  const target = new WebGLRenderTarget(width, height, { colorSpace: SRGBColorSpace });
  const geometry = new PlaneGeometry(2, 2);
  const material = new MeshBasicMaterial({ map: texture, toneMapped: false, transparent: true });
  const previewScene = new Scene();
  previewScene.add(new Mesh(geometry, material));
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 2);
  camera.position.z = 1;
  const previous = renderer.getRenderTarget();
  const color = renderer.getClearColor(new Color());
  const alpha = renderer.getClearAlpha();
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x181e25, 1);
    renderer.render(previewScene, camera);
    let pixels: Uint8Array;
    if (gl) {
      pixels = new Uint8Array(width * height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    } else {
      const reading = renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
      // 恢复屏幕绘制目标后再等待 GPU 回读，避免动画帧写进缩略图
      renderer.setRenderTarget(previous);
      renderer.setClearColor(color, alpha);
      const data = await reading;
      pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    const data = context.createImageData(width, height);
    // WebGL 回读从底部起算，WebGPU 和 PNG 从顶部起算
    for (let y = 0; y < height; y++) {
      const source = (gl ? height - 1 - y : y) * width * 4;
      data.data.set(pixels.subarray(source, source + width * 4), y * width * 4);
    }
    context.putImageData(data, 0, 0);
    return canvas.toDataURL("image/png");
  } finally {
    if (gl || renderer.getRenderTarget() === target) {
      if (gl) renderer.setRenderTarget(previous as ReturnType<WebGLRenderer["getRenderTarget"]>);
      else renderer.setRenderTarget(previous);
      renderer.setClearColor(color, alpha);
    }
    target.dispose();
    geometry.dispose();
    material.dispose();
  }
}

import {
  AxesHelper,
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Sphere,
  TorusKnotGeometry,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const homeDirection = new Vector3(4.8, 2.45, 6.2);
const fixedDirections = {
  front: new Vector3(0, 0, 1),
  side: new Vector3(1, 0, 0),
  top: new Vector3(0, 1, 0.00001),
};

export function createViewport(host: HTMLElement) {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setClearColor(new Color("#171e27"));
  host.append(renderer.domElement);

  const scene = new Scene();
  const defaultFov = 42;
  const camera = new PerspectiveCamera(defaultFov, 1, 0.05, 100);
  camera.position.set(4.8, 3.5, 6.2);
  const controls = new OrbitControls(camera, renderer.domElement);
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

  function fit(direction: Vector3) {
    const bounds = new Box3().setFromObject(model ?? sample, true);
    const sphere = bounds.getBoundingSphere(new Sphere());
    const radius = Math.max(sphere.radius, 0.0001);
    const offset = radius * 1.15 / Math.sin(defaultFov * Math.PI / 360);

    // 裁剪距离和操作范围随模型尺寸调整，源模型保留原始坐标与单位
    camera.near = radius / 1000;
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
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
    frame = requestAnimationFrame(() => {
      frame = undefined;
      renderer.render(scene, camera);
    });
  }

  function resize() {
    const { clientWidth: width, clientHeight: height } = host;
    if (!width || !height) return;
    camera.aspect = width / height;
    // 窄窗口保留初始水平视野，避免测试模型被两侧裁切
    const halfFov = defaultFov * Math.PI / 360;
    const narrowFov = 2 * Math.atan(Math.tan(halfFov) / camera.aspect);
    camera.fov = Math.max(defaultFov, narrowFov * 180 / Math.PI);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    scheduleRender();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(host);
  controls.addEventListener("change", scheduleRender);
  resize();

  return {
    setModel(next?: Object3D) {
      if (model) scene.remove(model);
      model = next;
      if (model) {
        scene.add(model);
        const bounds = new Box3().setFromObject(model);
        const scale = Math.max(bounds.getSize(new Vector3()).length() / 4, 0.0001);
        const center = bounds.getCenter(new Vector3());
        grid.position.set(center.x, bounds.isEmpty() ? 0 : bounds.min.y, center.z);
        grid.scale.setScalar(scale);
        axes.scale.setScalar(scale);
        fit(homeDirection);
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
      fit(camera.position.clone().sub(controls.target));
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
    dispose() {
      // 先停止重绘和输入，再释放视口持有的 GPU 资源
      observer.disconnect();
      controls.removeEventListener("change", scheduleRender);
      controls.dispose();
      if (frame !== undefined) cancelAnimationFrame(frame);
      sample.geometry.dispose();
      sample.material.dispose();
      grid.dispose();
      axes.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

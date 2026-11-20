<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fileName, isModelPath, loadModel, type Model } from "./viewer/model";
import { createViewport, type ViewMetrics } from "./viewer/viewport";
import { inspectScene, type DisplayMode, type SceneNode } from "./viewer/inspection";
import UVPreview from "./viewer/UVPreview.vue";
import type { Texture } from "three";
import { createRenderEngine, type Backend, type BackendPreference, type RenderEngine } from "./viewer/renderer";

function savedPreferences() {
  try { return JSON.parse(localStorage.getItem("viewer-preferences") ?? "{}") ?? {}; }
  catch { return {}; }
}

const saved = savedPreferences();

const host = ref<HTMLElement>();
const ready = ref(false);
const backendPreference = ref<BackendPreference>(saved.backend === "webgpu" || saved.backend === "webgl" ? saved.backend : "auto");
const activeBackend = ref<Backend>();
const switchingBackend = ref(false);
const backendNotice = ref("");
const showSample = ref(true);
const showGrid = ref(saved.grid !== false);
const showAxes = ref(saved.axes !== false);
const projection = ref<"perspective" | "orthographic">(saved.projection === "orthographic" ? "orthographic" : "perspective");
const studio = ref(saved.studio === true);
const exposure = ref(Number.isFinite(saved.exposure) ? Math.max(-3, Math.min(3, saved.exposure)) : 0);
const recent = ref<string[]>([]);
const full = ref(false);
const actionMessage = ref("");
const changeNotice = ref<"changed" | "unavailable">();
const measuring = ref(false);
const measureDistance = ref<number>();
const measureStarted = ref(false);
const uvOpen = ref(false);
const texturePreview = ref<{ url: string; name: string }>();
const loadTime = ref(0);
const modelBytes = ref(0);
const metrics = ref<ViewMetrics>();
const sampling = ref(false);
const dragging = ref(false);
const loading = ref(false);
const dialogOpen = ref(false);
const request = ref<{ path: string; folder?: string }>();
const displayedName = ref("");
const errorMessage = ref("");
const missingTextures = ref<string[]>([]);
const inspection = shallowRef<ReturnType<typeof inspectScene>>();
const selection = ref<string>();
const expanded = ref(new Set<string>());
const visibleNodes = shallowRef<Set<string>>();
const visibilityOverrides = new Map<string, boolean>();
const isolated = ref<string>();
const mode = ref<DisplayMode>("original");
const showBones = ref(false);
const materials = shallowRef<ReturnType<ReturnType<typeof createViewport>["materials"]>>([]);
const clips = shallowRef<{ name: string; duration: number }[]>([]);
const clipIndex = ref(0);
const playhead = ref(0);
const playing = ref(false);
const loop = ref(true);
const treePane = ref<HTMLElement>();
const chosenNode = computed(() => selection.value && inspection.value?.nodes.get(selection.value) || undefined);
const duration = computed(() => clips.value[clipIndex.value]?.duration ?? 0);
const numberFormat = new Intl.NumberFormat("zh-CN");
const dimensionFormat = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 5 });
const slotLabels: Record<string, string> = {
  map: "颜色", normalMap: "法线", roughnessMap: "粗糙度", metalnessMap: "金属度",
  emissiveMap: "自发光", aoMap: "环境遮蔽", alphaMap: "透明度", bumpMap: "凹凸", specularMap: "高光",
};
const sceneRows = computed(() => {
  const rows: { node: SceneNode; depth: number }[] = [];
  function collect(node: SceneNode, depth: number) {
    rows.push({ node, depth });
    if (expanded.value.has(node.id)) node.children.forEach((child) => collect(child, depth + 1));
  }
  if (inspection.value) collect(inspection.value.tree, 0);
  return rows;
});
let viewport: ReturnType<typeof createViewport> | undefined;
let activeModel: Model | undefined;
let unlistenDrop: (() => void) | undefined;
let disposed = false;
let requestId = 0;
let watchTimer: ReturnType<typeof setInterval> | undefined;
let checkingFile = false;
let watchedModel: { path: string; folder?: string; stamp?: string } | undefined;
let textureRequestId = 0;

onMounted(() => {
  void switchBackend(backendPreference.value);
  try {
    if ("__TAURI_INTERNALS__" in window) {
      void invoke<string[]>("recent_models").then((paths) => { recent.value = paths; }).catch(console.error);
      watchTimer = setInterval(() => { void checkFile(); }, 900);
      const webview = getCurrentWebview();
      const listeners = [webview.onDragDropEvent(({ payload }) => {
        dragging.value = payload.type === "enter" || payload.type === "over";
      }), webview.listen<string[]>("model-files-dropped", ({ payload }) => {
        dragging.value = false;
        if (payload.length) void openPath(payload.find(isModelPath) ?? payload[0]);
      })];
      void Promise.allSettled(listeners).then((results) => {
        const stop = () => results.forEach((result) => {
          if (result.status === "fulfilled") result.value();
        });
        if (disposed) stop();
        else unlistenDrop = stop;
        for (const result of results) {
          if (result.status === "rejected") console.error("无法监听模型拖拽", result.reason);
        }
      });
    }
    window.addEventListener("keydown", onShortcut);
  } catch (error) {
    console.error("无法初始化桌面事件", error);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  requestId++;
  unlistenDrop?.();
  clearInterval(watchTimer);
  window.removeEventListener("keydown", onShortcut);
  viewport?.dispose();
  activeModel?.dispose();
});

function applyPreferences(target = viewport) {
  target?.setGridVisible(showGrid.value);
  target?.setAxesVisible(showAxes.value);
  target?.setProjection(projection.value);
  target?.setLighting(studio.value, exposure.value);
}

watch([showGrid, showAxes, projection, studio, exposure], () => {
  applyPreferences();
  savePreferences();
});

function savePreferences() {
  try {
    localStorage.setItem("viewer-preferences", JSON.stringify({
      grid: showGrid.value, axes: showAxes.value, projection: projection.value,
      studio: studio.value, exposure: exposure.value, backend: backendPreference.value,
    }));
  } catch (error) { console.error(error); }
}

function formatReason(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function switchBackend(preference: BackendPreference, recovery?: string) {
  if (!host.value || switchingBackend.value || disposed || (!recovery && loading.value)) return;
  const element = host.value;
  const previous = viewport;
  const source = watchedModel;
  if (!recovery) {
    backendPreference.value = preference;
    savePreferences();
  } else {
    // 设备掉线后废弃仍在等待旧后端的加载请求
    requestId++;
    loading.value = false;
  }
  switchingBackend.value = true;
  backendNotice.value = recovery ?? "";
  let fallback: string | undefined;
  let engine: RenderEngine | undefined;
  let candidate: ReturnType<typeof createViewport> | undefined;
  let next: Model | undefined;
  try {
    let wanted: Backend = recovery || preference === "webgl" ? "webgl" : "webgpu";
    if (!recovery && previous && wanted === activeBackend.value) return;
    if (wanted === "webgpu") {
      try {
        engine = await createRenderEngine("webgpu");
      } catch (error) {
        wanted = "webgl";
        backendNotice.value = `WebGPU 无法启用 · ${formatReason(error)}。已回退到 WebGL 2。`;
      }
    }
    if (!recovery && previous && wanted === activeBackend.value) return;
    engine ??= await createRenderEngine(wanted);

    let stamp: string | undefined;
    const started = performance.now();
    if (source) {
      try {
        stamp = await invoke<string>("model_stamp", { path: source.path }).catch(() => undefined);
        // 后端可能支持不同压缩纹理格式，用目标 GPU 的能力重新解码模型
        next = await loadModel(source.path, engine.renderer, source.folder);
      } catch (error) {
        if (!recovery) throw error;
        backendNotice.value += `。${formatReason(error)}，请重新打开模型。`;
      }
    }
    if (disposed) return;

    const summary = next ? inspectScene(next.root) : undefined;
    candidate = createViewport(element, engine, {
      select: (id) => selectNode(id, true),
      playback: (time, isPlaying) => {
        playhead.value = time;
        playing.value = isPlaying;
      },
      measure: (distance, started) => {
        measureDistance.value = distance;
        measureStarted.value = !!started;
      },
    });
    applyPreferences(candidate);
    candidate.setModel(next, summary?.box);
    candidate.setSampleVisible(showSample.value);
    const nextViewport = candidate;
    engine.onLost((reason) => {
      if (viewport === nextViewport) void switchBackend("webgl", `WebGPU 设备中断 · ${reason}`);
    });
    previous?.dispose();
    activeModel?.dispose();
    viewport = candidate;
    activeModel = next;
    activeBackend.value = engine.backend;
    ready.value = true;
    candidate = undefined;
    engine = undefined;
    next = undefined;
    resetInspection(activeModel, summary);
    if (activeModel && source) {
      watchedModel = { path: source.path, folder: source.folder, stamp };
      request.value = { path: source.path, folder: source.folder };
      missingTextures.value = activeModel.missingTextures;
      errorMessage.value = "";
      loadTime.value = performance.now() - started;
      modelBytes.value = activeModel.bytes;
      changeNotice.value = undefined;
    } else if (recovery) {
      watchedModel = undefined;
      displayedName.value = "";
      missingTextures.value = [];
      changeNotice.value = undefined;
    }
    if (recovery) backendNotice.value += "。已回退到 WebGL 2。";
  } catch (error) {
    backendNotice.value = `无法切换渲染后端 · ${formatReason(error)}`;
    if (!previous && engine?.backend === "webgpu") fallback = `WebGPU 无法启用 · ${formatReason(error)}`;
    console.error(error);
  } finally {
    if (candidate) candidate.dispose();
    else engine?.dispose();
    next?.dispose();
    switchingBackend.value = false;
  }
  if (fallback) await switchBackend("webgl", fallback);
}

async function checkFile() {
  const source = watchedModel;
  if (!source || disposed || checkingFile || loading.value) return;
  checkingFile = true;
  try {
    const stamp = await invoke<string>("model_stamp", { path: source.path });
    if (source !== watchedModel) return;
    if (source.stamp === undefined) source.stamp = stamp;
    changeNotice.value = source.stamp === stamp ? undefined : "changed";
  } catch {
    if (source === watchedModel) changeNotice.value = "unavailable";
  } finally { checkingFile = false; }
}

async function openRecent(path: string, event: MouseEvent) {
  const menu = (event.currentTarget as HTMLElement).closest("details");
  if (menu) menu.open = false;
  const id = requestId;
  try {
    await invoke("authorize_recent", { path });
    if (id === requestId) void openPath(path);
  } catch (error) {
    if (id === requestId) errorMessage.value = `无法打开「${fileName(path)}」`;
    console.error(error);
  }
}

async function toggleFullscreen() {
  try {
    const native = getCurrentWindow();
    const next = !(await native.isFullscreen());
    await native.setFullscreen(next);
    full.value = next;
  } catch (error) { console.error(error); }
}

async function saveScreenshot() {
  if (dialogOpen.value || switchingBackend.value || !viewport) return;
  dialogOpen.value = true;
  actionMessage.value = "";
  try {
    const png = await viewport.capture();
    const name = `${displayedName.value.replace(/\.(glb|fbx)$/i, "") || "模型预览"}.png`;
    const path = await invoke<string | null>("save_screenshot", { name, png: Array.from(new Uint8Array(await png.arrayBuffer())) });
    if (path) actionMessage.value = `已保存 ${fileName(path)}`;
  } catch (error) {
    actionMessage.value = "无法保存 PNG 截图";
    console.error(error);
  } finally { dialogOpen.value = false; }
}

function onShortcut(event: KeyboardEvent) {
  if (event.repeat || event.altKey) return;
  if (event.key === "F11" || (event.key === "Escape" && full.value)) {
    event.preventDefault();
    void toggleFullscreen();
  } else if (event.ctrlKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    void choosePath("model");
  } else if (event.ctrlKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveScreenshot();
  } else if (event.ctrlKey && event.key.toLowerCase() === "r") {
    event.preventDefault();
    if (!loading.value && request.value) void openPath(request.value.path, request.value.folder);
  }
}

async function sampleFrames() {
  if (!viewport || sampling.value || switchingBackend.value) return;
  const model = activeModel;
  sampling.value = true;
  try {
    const result = await viewport.sampleFrames();
    if (activeModel === model) metrics.value = result;
  } finally { sampling.value = false; }
}

async function showTexture(texture: Texture, name: string) {
  if (switchingBackend.value) return;
  const id = ++textureRequestId;
  try {
    const url = await viewport?.previewTexture(texture);
    if (id === textureRequestId) texturePreview.value = url ? { url, name } : undefined;
  } catch (error) {
    if (id !== textureRequestId) return;
    texturePreview.value = undefined;
    actionMessage.value = "无法预览所选贴图";
    console.error(error);
  }
}

function selectNode(id?: string, reveal = false) {
  selection.value = id;
  const object = chosenNode.value;
  viewport?.select(object);
  materials.value = viewport?.materials(object) ?? [];
  textureRequestId++;
  texturePreview.value = undefined;
  if (!reveal || !object || !inspection.value) return;
  for (let parent = object.parent; parent && inspection.value.nodes.has(parent.uuid); parent = parent.parent) {
    expanded.value.add(parent.uuid);
  }
  void nextTick(() => treePane.value?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" }));
}

function toggleExpanded(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id);
  else expanded.value.add(id);
}

function updateVisibility() {
  const object = isolated.value ? inspection.value?.nodes.get(isolated.value) : undefined;
  visibleNodes.value = viewport?.setVisibility(visibilityOverrides, object);
}

function toggleNodeVisibility() {
  const id = selection.value;
  if (!id) return;
  const willShow = !visibleNodes.value?.has(id);
  if (willShow) {
    isolated.value = undefined;
    for (let node = chosenNode.value; node && inspection.value?.nodes.has(node.uuid); node = node.parent ?? undefined) {
      visibilityOverrides.set(node.uuid, true);
    }
  } else {
    if (isolated.value === id) isolated.value = undefined;
    visibilityOverrides.set(id, false);
  }
  updateVisibility();
}

function toggleIsolation() {
  isolated.value = isolated.value ? undefined : selection.value;
  updateVisibility();
}

function resetInspection(next?: Model, summary?: ReturnType<typeof inspectScene>) {
  inspection.value = summary;
  expanded.value = new Set(inspection.value ? [inspection.value.tree.id] : []);
  isolated.value = undefined;
  visibilityOverrides.clear();
  updateVisibility();
  selectNode();
  mode.value = "original";
  showBones.value = false;
  measuring.value = false;
  metrics.value = undefined;
  clips.value = next?.animations.map((clip, index) => ({ name: clip.name || `片段 ${index + 1}`, duration: clip.duration })) ?? [];
  clipIndex.value = 0;
  playhead.value = 0;
  playing.value = false;
  loop.value = true;
  if (next?.animations.length) viewport?.selectClip(next.animations[0]);
}

function changeClip(index: number) {
  const clip = activeModel?.animations[index];
  if (!clip) return;
  clipIndex.value = index;
  viewport?.selectClip(clip);
}

const dimensions = computed(() => {
  const size = inspection.value?.size;
  if (!size) return "—";
  const unit = /\.glb$/i.test(displayedName.value) ? "m" : "场景单位";
  return `${size.map((value) => dimensionFormat.format(value)).join(" × ")} ${unit}`;
});

async function openPath(path: string, folder?: string) {
  if (!viewport || switchingBackend.value) return;
  const id = ++requestId;
  errorMessage.value = "";
  if (!isModelPath(path)) {
    loading.value = false;
    errorMessage.value = `不支持「${fileName(path)}」。请选择 GLB 或 FBX 文件。`;
    return;
  }

  missingTextures.value = [];
  request.value = { path, folder };
  loading.value = true;
  const started = performance.now();
  try {
    const stamp = await invoke<string>("model_stamp", { path }).catch(() => undefined);
    if (id !== requestId) return;
    const next = await loadModel(path, viewport.renderer, folder);
    // 较早的加载即使最后才结束，也不会覆盖当前模型
    if (id !== requestId) {
      next.dispose();
      return;
    }
    const summary = inspectScene(next.root);
    viewport.setModel(next, summary.box);
    showSample.value = false;
    viewport?.setSampleVisible(false);
    activeModel?.dispose();
    activeModel = next;
    displayedName.value = fileName(path);
    missingTextures.value = next.missingTextures;
    resetInspection(next, summary);
    watchedModel = { path, folder, stamp };
    changeNotice.value = undefined;
    actionMessage.value = "";
    loadTime.value = performance.now() - started;
    modelBytes.value = next.bytes;
    void invoke<string[]>("remember_model", { path }).then((paths) => {
      if (id === requestId) recent.value = paths;
    }).catch(console.error);
  } catch (error) {
    if (id === requestId) {
      errorMessage.value = error instanceof Error ? error.message : "加载模型失败";
      console.error(error);
    }
  } finally {
    if (id === requestId) loading.value = false;
  }
}

async function choosePath(kind: "model" | "folder") {
  if (dialogOpen.value || switchingBackend.value || !ready.value) return;
  const id = requestId;
  const current = request.value;
  dialogOpen.value = true;
  try {
    const path = await invoke<string | null>(kind === "model" ? "pick_model" : "pick_texture_folder");
    if (!path || id !== requestId) return;
    if (kind === "model") void openPath(path);
    else if (current) void openPath(current.path, path);
  } catch (error) {
    if (id === requestId) errorMessage.value = kind === "model" ? "无法打开文件选择器" : "无法打开目录选择器";
    console.error(error);
  } finally {
    dialogOpen.value = false;
  }
}

function closeModel() {
  if (switchingBackend.value) return;
  requestId++;
  viewport?.setModel();
  activeModel?.dispose();
  activeModel = undefined;
  request.value = undefined;
  displayedName.value = "";
  errorMessage.value = "";
  missingTextures.value = [];
  loading.value = false;
  watchedModel = undefined;
  changeNotice.value = undefined;
  resetInspection();
}

function toggleSample() {
  showSample.value = !showSample.value;
  viewport?.setSampleVisible(showSample.value);
}
</script>

<template>
  <main class="workspace">
    <header class="toolbar">
      <h1>模型预览</h1>
      <div class="actions" v-if="ready">
        <button class="primary" type="button" :disabled="dialogOpen || switchingBackend" @click="choosePath('model')">打开模型</button>
        <details v-if="recent.length" class="popup recent-menu">
          <summary>最近打开</summary>
          <div class="popup-content">
            <button v-for="path in recent" :key="path" :title="path" type="button" :disabled="switchingBackend" @click="openRecent(path, $event)">{{ fileName(path) }}</button>
          </div>
        </details>
        <button type="button" :disabled="!request || loading || switchingBackend" @click="request && openPath(request.path, request.folder)">重新加载</button>
        <button type="button" :disabled="!request || switchingBackend" @click="closeModel">关闭模型</button>
        <button type="button" title="Ctrl+S" :disabled="dialogOpen || switchingBackend" @click="saveScreenshot">截图</button>
        <button type="button" title="F11" :aria-pressed="full" @click="toggleFullscreen">{{ full ? '退出全屏' : '全屏' }}</button>
      </div>
      <select class="backend-select" :value="backendPreference" aria-label="渲染后端"
        :disabled="switchingBackend || loading || dialogOpen"
        @change="switchBackend(($event.target as HTMLSelectElement).value as BackendPreference)">
        <option value="auto">自动</option>
        <option value="webgpu">WebGPU</option>
        <option value="webgl">WebGL 2</option>
      </select>
    </header>

    <div v-if="backendNotice" class="backend-notice" role="status">
      <span>{{ backendNotice }}</span>
      <button v-if="backendPreference !== 'webgl' && activeBackend !== 'webgpu'" type="button"
        :disabled="switchingBackend || loading || dialogOpen" @click="switchBackend(backendPreference)">
        重试 WebGPU
      </button>
      <button v-if="backendPreference !== 'webgl'" type="button" :disabled="switchingBackend || loading || dialogOpen"
        @click="switchBackend('webgl')">使用 WebGL 2</button>
    </div>

    <div class="editor" :class="{ inspecting: inspection }">
      <aside v-if="inspection" class="scene-panel panel" aria-labelledby="scene-title">
        <h2 id="scene-title">场景树</h2>
        <div ref="treePane" class="scene-rows" role="group" aria-label="场景节点">
          <div v-for="{ node, depth } in sceneRows" :key="node.id" class="scene-row"
            :class="{ hidden: !visibleNodes?.has(node.id) }" :style="{ paddingInlineStart: `${Math.min(depth, 12) * 12}px` }">
            <button v-if="node.children.length" class="expander" type="button" :aria-expanded="expanded.has(node.id)"
              :aria-label="`${expanded.has(node.id) ? '折叠' : '展开'} ${node.name}`" @click="toggleExpanded(node.id)">
              {{ expanded.has(node.id) ? '▾' : '▸' }}
            </button>
            <span v-else class="expander-spacer" aria-hidden="true"></span>
            <button type="button" class="node-name" :aria-current="selection === node.id ? 'true' : undefined" :title="node.name"
              @click="selectNode(node.id)" @dblclick="viewport?.focus()">{{ node.name }}</button>
          </div>
        </div>
        <div class="panel-actions actions">
          <button type="button" :disabled="!selection" @click="toggleNodeVisibility">
            {{ selection && !visibleNodes?.has(selection) ? '显示节点' : '隐藏节点' }}
          </button>
          <button type="button" :disabled="!selection && !isolated" @click="toggleIsolation">
            {{ isolated ? '退出独显' : '单独显示' }}
          </button>
        </div>
      </aside>

      <section class="stage" :class="{ dragging }" aria-label="3D 视口">
        <div ref="host" class="canvas-host"></div>
        <div v-if="ready" class="view-tools actions" aria-label="视口工具">
          <button v-if="!displayedName" type="button" :aria-pressed="showSample" @click="toggleSample">测试场景</button>
          <button type="button" @click="viewport?.resetView()">重置视角</button>
          <button type="button" :disabled="!displayedName && !showSample" @click="viewport?.focus()">聚焦</button>
          <button type="button" @click="viewport?.setView('front')">前视</button>
          <button type="button" @click="viewport?.setView('side')">侧视</button>
          <button type="button" @click="viewport?.setView('top')">顶视</button>
          <button type="button" :aria-pressed="showGrid" @click="showGrid = !showGrid; viewport?.setGridVisible(showGrid)">网格</button>
          <button type="button" :aria-pressed="showAxes" @click="showAxes = !showAxes; viewport?.setAxesVisible(showAxes)">坐标轴</button>
          <button v-if="inspection?.bones" type="button" :aria-pressed="showBones"
            @click="showBones = !showBones; viewport?.setSkeletonVisible(showBones)">骨骼</button>
          <select v-if="inspection" v-model="mode" aria-label="显示模式" @change="viewport?.setDisplayMode(mode)">
            <option value="original">默认材质</option>
            <option value="solid">纯色</option>
            <option value="wireframe">线框</option>
          </select>
            <details class="popup view-menu">
              <summary>视口设置</summary>
              <div class="popup-content view-settings">
                <label>投影 <select v-model="projection"><option value="perspective">透视</option><option value="orthographic">正交</option></select></label>
                <label><input v-model="studio" type="checkbox" />HDR 影棚光</label>
                <label>曝光 {{ exposure.toFixed(1) }} EV <input v-model.number="exposure" type="range" min="-3" max="3" step="0.1" /></label>
              </div>
            </details>
            <button v-if="inspection" type="button" :aria-pressed="measuring" @click="measuring = !measuring; viewport?.setMeasuring(measuring)">测距</button>
        </div>
        <p v-if="switchingBackend" class="notice" role="status">正在切换渲染后端…</p>
        <p v-else-if="!ready" class="notice" role="status">3D 视口不可用，请检查显卡驱动和硬件加速设置。</p>
        <p v-else-if="dragging" class="notice" role="status">松开鼠标以打开模型</p>
        <p v-else-if="loading" class="notice" role="status">正在加载 {{ request && fileName(request.path) }}…</p>
        <p v-else-if="!displayedName && !showSample" class="notice" role="status">拖入 GLB 或 FBX 文件</p>
          <aside v-if="errorMessage || missingTextures.length || changeNotice || measuring || actionMessage" class="messages" aria-live="polite">
          <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
            <p v-if="actionMessage">{{ actionMessage }}</p>
            <p v-if="measuring">
              {{ measureDistance !== undefined ? `距离 ${dimensionFormat.format(measureDistance)} ${/\.glb$/i.test(displayedName) ? 'm' : '场景单位'}` : measureStarted ? '点击模型上的第二个点' : '点击模型上的第一个点' }}
            </p>
            <template v-if="changeNotice">
              <p>{{ changeNotice === 'unavailable' ? '当前模型文件暂时不可读，已保留预览。' : '当前模型文件已改变。' }}</p>
              <button type="button" :disabled="loading" @click="watchedModel && openPath(watchedModel.path, watchedModel.folder)">重载当前模型</button>
            </template>
          <template v-if="missingTextures.length">
            <p>缺失或无法读取的贴图</p>
            <ul><li v-for="name in missingTextures" :key="name">{{ name }}</li></ul>
            <button type="button" :disabled="dialogOpen" @click="choosePath('folder')">选择贴图目录并重试</button>
          </template>
        </aside>
      </section>

      <aside v-if="inspection" class="properties panel" aria-labelledby="properties-title">
        <h2 id="properties-title">属性</h2>
        <div class="property-content">
          <dl class="stats">
            <dt>网格</dt><dd>{{ numberFormat.format(inspection.meshes) }}</dd>
            <dt>顶点</dt><dd>{{ numberFormat.format(inspection.vertices) }}</dd>
            <dt>三角面</dt><dd>{{ numberFormat.format(inspection.triangles) }}</dd>
            <dt class="size-label">包围盒（X × Y × Z）</dt><dd class="size-value">{{ dimensions }}</dd>
          </dl>
          <details class="inspector-details">
            <summary>性能</summary>
            <p>{{ (modelBytes / 1048576).toFixed(2) }} MiB · 加载 {{ Math.round(loadTime) }} ms</p>
            <button type="button" :disabled="sampling" @click="sampleFrames">{{ sampling ? '采样中…' : '采样帧时间' }}</button>
            <p v-if="metrics">中位数 {{ metrics.median.toFixed(1) }} ms · P95 {{ metrics.p95.toFixed(1) }} ms<br />几何 {{ metrics.geometries }} · 纹理 {{ metrics.textures }}</p>
          </details>
          <section class="node-properties" aria-label="所选节点属性">
            <h3>{{ chosenNode ? chosenNode.name || chosenNode.type : '所选节点' }}</h3>
            <p v-if="!chosenNode" class="muted">点击模型或场景树查看材质</p>
            <template v-else>
              <p class="muted">{{ chosenNode.type }} · {{ visibleNodes?.has(chosenNode.uuid) ? '可见' : '已隐藏' }}</p>
              <p v-if="!materials.length" class="muted">此节点及子节点没有材质</p>
              <div v-for="material in materials" :key="material.id" class="material">
                <strong>{{ material.name }}</strong>
                <span v-if="material.name !== material.type" class="muted">{{ material.type }}</span>
                <span v-if="!material.textures.length" class="muted">无贴图</span>
                <ul v-else>
                  <li v-for="texture in material.textures" :key="texture.slot">
                    <span class="muted">{{ slotLabels[texture.slot] || texture.slot }} · {{ texture.size }}</span>
                      <button type="button" class="texture-button" :disabled="texture.size === '未载入'" @click="showTexture(texture.texture, texture.name)">{{ texture.name }}</button>
                  </li>
                </ul>
              </div>
              <figure v-if="texturePreview" class="texture-preview">
                <img :src="texturePreview.url" :alt="texturePreview.name" />
                <figcaption>{{ texturePreview.name }}</figcaption>
              </figure>
              <details class="inspector-details" @toggle="uvOpen = ($event.currentTarget as HTMLDetailsElement).open">
                <summary>UV 检查</summary>
                <UVPreview v-if="uvOpen" :node="chosenNode" />
              </details>
            </template>
          </section>
        </div>
      </aside>
    </div>

    <section v-if="clips.length" class="animation-bar" aria-label="动画播放">
      <select :value="clipIndex" aria-label="动画片段" @change="changeClip(Number(($event.target as HTMLSelectElement).value))">
        <option v-for="(clip, index) in clips" :key="index" :value="index">{{ clip.name }}</option>
      </select>
      <button type="button" :disabled="!duration" @click="viewport?.setPlaying(!playing)">{{ playing ? '暂停' : '播放' }}</button>
      <label class="loop"><input v-model="loop" type="checkbox" @change="viewport?.setLoop(loop)" />循环</label>
      <input class="timeline" type="range" aria-label="动画进度" min="0" :max="duration" step="any" :value="playhead"
        :disabled="!duration" @input="viewport?.seek(Number(($event.target as HTMLInputElement).value))" />
      <span class="time">{{ playhead.toFixed(2) }} / {{ duration.toFixed(2) }} s</span>
    </section>

    <footer class="statusbar">
      <span class="model-name" :title="displayedName">{{ displayedName || (showSample ? "测试场景" : "暂无模型") }}</span>
      <span v-if="ready" class="gestures">左键旋转 · 右键平移 · 滚轮缩放</span>
      <span class="active-backend" :data-backend="activeBackend">{{ activeBackend === 'webgpu' ? 'WebGPU' : activeBackend === 'webgl' ? 'WebGL 2' : '渲染不可用' }}</span>
    </footer>
  </main>
</template>

<style>
:root {
  font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
  color-scheme: dark;
  color: #e4edf4;
  background: #11171f;
}

* { box-sizing: border-box; }
body { margin: 0; }

.workspace {
  display: grid;
  grid-template: "toolbar" auto "notice" auto "editor" minmax(0, 1fr) "animation" auto "status" auto / minmax(0, 1fr);
  height: 100dvh;
}

.toolbar, .statusbar, .animation-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 10px 16px;
  background: #11171f;
}

.toolbar { border-bottom: 1px solid #303d4d; }
h1 { margin: 0; font-size: 16px; font-weight: 650; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }

button, select {
  padding: 6px 10px;
  border: 1px solid #425365;
  border-radius: 5px;
  background: #222d3a;
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

button[aria-pressed="true"] { color: #aaf2e3; border-color: #519187; background: #203c3c; }
.primary { background: #aaf2e3; color: #132d2d; border-color: #aaf2e3; font-weight: 650; }
button:disabled { cursor: default; opacity: 0.5; }
button:hover:not(:disabled) { filter: brightness(1.2); }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #9af6e5; outline-offset: 2px; }
.toolbar { position: relative; z-index: 3; }
.toolbar { grid-area: toolbar; }
.backend-notice { grid-area: notice; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; padding: 6px 16px; border-bottom: 1px solid #604d36; color: #ffe0b5; background: #221d19; font-size: 13px; overflow-wrap: anywhere; }
.editor { grid-area: editor; }
.animation-bar { grid-area: animation; }
.statusbar { grid-area: status; }
.popup { position: relative; pointer-events: auto; }
.popup summary { padding: 6px 10px; border: 1px solid #425365; border-radius: 5px; background: #222d3a; font-size: 13px; cursor: pointer; }
.popup-content { position: absolute; z-index: 2; top: calc(100% + 5px); inset-inline-start: 0; min-width: 145px; max-width: min(240px, 52vw); padding: 8px; display: grid; gap: 6px; background: #151c25; border: 1px solid #425365; border-radius: 6px; box-shadow: 0 8px 20px #0a0e14ab; }
.popup-content button { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: start; }
.view-menu .popup-content { inset-inline-start: auto; inset-inline-end: 0; }
.view-settings label { display: grid; gap: 3px; font-size: 13px; }
.view-settings label:has(input[type="checkbox"]) { display: flex; align-items: center; }

.editor { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; }
.editor.inspecting { grid-template-columns: minmax(140px, 0.85fr) minmax(0, 2fr) minmax(170px, 1fr); }
.panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: #151c25; }
.scene-panel { border-inline-end: 1px solid #303d4d; }
.properties { border-inline-start: 1px solid #303d4d; }
.panel h2 { margin: 0; padding: 11px 12px; border-bottom: 1px solid #303d4d; font-size: 13px; font-weight: 650; }
.scene-rows, .property-content { min-height: 0; overflow: auto; padding: 8px; }
.scene-rows { flex: 1; }
.scene-row { display: flex; align-items: center; gap: 3px; }
.scene-row.hidden { color: #9aacb9; }
.scene-row.hidden .node-name { text-decoration: line-through; }
.expander, .expander-spacer { flex: 0 0 20px; }
.expander, .node-name { border-color: transparent; background: transparent; }
.expander { padding: 2px; }
.node-name { min-width: 0; width: 100%; text-align: start; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-name[aria-current="true"] { background: #203c3c; border-color: #519187; color: #b0f4e6; }
.panel-actions { border-top: 1px solid #303d4d; padding: 8px; }
.property-content { padding: 10px 12px; font-size: 13px; overflow-wrap: anywhere; }
.stats { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; margin: 0; }
.stats dt, .muted { color: #aebdcc; }
.stats dd { margin: 0; text-align: end; font-variant-numeric: tabular-nums; }
.stats .size-label, .stats .size-value { grid-column: 1 / -1; text-align: start; }
.node-properties { margin-top: 14px; border-top: 1px solid #303d4d; padding-top: 12px; }
.node-properties h3, .node-properties p { margin: 0 0 8px; font-size: 13px; }
.material { display: grid; gap: 4px; border: 1px solid #303d4d; border-radius: 5px; padding: 8px; margin-top: 8px; }
.material ul { margin: 0; padding: 0; list-style: none; }
.material li { display: grid; gap: 3px; border-top: 1px solid #303d4d; margin-top: 5px; padding-top: 5px; }
.inspector-details { border-top: 1px solid #303d4d; margin-top: 10px; padding-top: 8px; }
.inspector-details summary { cursor: pointer; }
.inspector-details p { margin: 6px 0; color: #aebdcc; }
.texture-button { text-align: start; overflow-wrap: anywhere; }
.texture-preview { margin: 8px 0; }
.texture-preview img { display: block; max-width: 100%; border: 1px solid #425365; }
.texture-preview figcaption { margin-top: 4px; color: #aebdcc; }
.animation-bar { justify-content: flex-start; border-top: 1px solid #303d4d; font-size: 13px; }
.animation-bar select { max-width: 36%; }
.timeline { flex: 1; min-width: 70px; accent-color: #aaf2e3; }
.loop { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.time { white-space: nowrap; font-variant-numeric: tabular-nums; }

@media (max-width: 650px) {
  .editor.inspecting { grid-template: minmax(0, 1.4fr) minmax(0, 1fr) / 1fr 1fr; }
  .editor.inspecting .stage { grid-area: 1 / 1 / 2 / -1; }
  .scene-panel, .properties { border-top: 1px solid #303d4d; }
  .properties { border-inline-start: 0; }
}

.stage { position: relative; min-width: 0; overflow: hidden; background: #171e27; }
.canvas-host { position: absolute; inset: 0; }
.canvas-host canvas { display: block; width: 100%; height: 100%; }
.view-tools { position: absolute; top: 12px; left: 16px; right: 16px; pointer-events: none; }
.view-tools button { pointer-events: auto; }
.view-tools select { pointer-events: auto; }
.dragging { outline: 2px solid #aaf2e3; outline-offset: -2px; }

.notice {
  position: absolute;
  inset: 0;
  width: fit-content;
  height: fit-content;
  max-width: calc(100% - 32px);
  margin: auto;
  padding: 10px 16px;
  border: 1px solid #425365;
  border-radius: 6px;
  background: #11171f;
  pointer-events: none;
}

.statusbar { border-top: 1px solid #303d4d; color: #b3c3d1; font-size: 12px; }
.model-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.messages {
  position: absolute;
  bottom: 12px;
  left: 16px;
  max-width: calc(100% - 32px);
  max-height: 45%;
  overflow: auto;
  padding: 10px 14px;
  border: 1px solid #82603b;
  border-radius: 6px;
  background: #221d19;
  color: #ffe0b5;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.messages p { margin: 0; }
.messages ul { margin: 6px 0 9px; padding-left: 22px; }
</style>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { fileName, isModelPath, loadModel, type Model } from "./viewer/model";
import { createViewport } from "./viewer/viewport";

const host = ref<HTMLElement>();
const ready = ref(false);
const showSample = ref(true);
const showGrid = ref(true);
const showAxes = ref(true);
const dragging = ref(false);
const loading = ref(false);
const dialogOpen = ref(false);
const request = ref<{ path: string; folder?: string }>();
const displayedName = ref("");
const errorMessage = ref("");
const missingTextures = ref<string[]>([]);
let viewport: ReturnType<typeof createViewport> | undefined;
let activeModel: Model | undefined;
let unlistenDrop: (() => void) | undefined;
let disposed = false;
let requestId = 0;

onMounted(() => {
  if (!host.value) return;
  try {
    viewport = createViewport(host.value);
    ready.value = true;
    if ("__TAURI_INTERNALS__" in window) {
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
  } catch (error) {
    console.error("无法初始化 3D 视口", error);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  requestId++;
  unlistenDrop?.();
  activeModel?.dispose();
  viewport?.dispose();
});

async function openPath(path: string, folder?: string) {
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
  try {
    const next = await loadModel(path, folder);
    // 较早的加载即使最后才结束，也不会覆盖当前模型
    if (id !== requestId) {
      next.dispose();
      return;
    }
    viewport?.setModel(next.root);
    showSample.value = false;
    viewport?.setSampleVisible(false);
    activeModel?.dispose();
    activeModel = next;
    displayedName.value = fileName(path);
    missingTextures.value = next.missingTextures;
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
  if (dialogOpen.value) return;
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
  requestId++;
  viewport?.setModel();
  activeModel?.dispose();
  activeModel = undefined;
  request.value = undefined;
  displayedName.value = "";
  errorMessage.value = "";
  missingTextures.value = [];
  loading.value = false;
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
        <button class="primary" type="button" :disabled="dialogOpen" @click="choosePath('model')">打开模型</button>
        <button type="button" :disabled="!request || loading" @click="request && openPath(request.path, request.folder)">重新加载</button>
        <button type="button" :disabled="!request" @click="closeModel">关闭模型</button>
      </div>
    </header>

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
      </div>
      <p v-if="!ready" class="notice" role="status">无法初始化 WebGL 2，请检查显卡驱动和硬件加速设置。</p>
      <p v-else-if="dragging" class="notice" role="status">松开鼠标以打开模型</p>
      <p v-else-if="loading" class="notice" role="status">正在加载 {{ request && fileName(request.path) }}…</p>
      <p v-else-if="!displayedName && !showSample" class="notice" role="status">拖入 GLB 或 FBX 文件</p>
      <aside v-if="errorMessage || missingTextures.length" class="messages" aria-live="polite">
        <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
        <template v-if="missingTextures.length">
          <p>缺失或无法读取的贴图</p>
          <ul><li v-for="name in missingTextures" :key="name">{{ name }}</li></ul>
          <button type="button" :disabled="dialogOpen" @click="choosePath('folder')">选择贴图目录并重试</button>
        </template>
      </aside>
    </section>

    <footer class="statusbar">
      <span class="model-name" :title="displayedName">{{ displayedName || (showSample ? "测试场景" : "暂无模型") }}</span>
      <span v-if="ready" class="gestures">左键旋转 · 右键平移 · 滚轮缩放</span>
      <span>{{ ready ? "WebGL 2" : "渲染不可用" }}</span>
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
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100dvh;
}

.toolbar, .statusbar {
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

button {
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
button:focus-visible { outline: 2px solid #9af6e5; outline-offset: 2px; }

.stage { position: relative; min-width: 0; overflow: hidden; background: #171e27; }
.canvas-host { position: absolute; inset: 0; }
.canvas-host canvas { display: block; width: 100%; height: 100%; }
.view-tools { position: absolute; top: 12px; left: 16px; right: 16px; pointer-events: none; }
.view-tools button { pointer-events: auto; }
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

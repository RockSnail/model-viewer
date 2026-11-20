<script setup lang="ts">
import { ref, watchEffect } from "vue";
import { Mesh, type Object3D } from "three";

const props = defineProps<{ node?: Object3D }>();
const canvas = ref<HTMLCanvasElement>();
const status = ref("");

watchEffect(() => {
  const context = canvas.value?.getContext("2d");
  if (!context) return;
  const size = 192;
  const edge = 12;
  const span = size - 2 * edge;
  context.fillStyle = "#11171f";
  context.fillRect(0, 0, size, size);
  context.strokeStyle = "#627689";
  context.strokeRect(edge, edge, span, span);
  const mesh = props.node;
  const uv = mesh instanceof Mesh ? mesh.geometry.getAttribute("uv") : undefined;
  if (!uv || !(mesh instanceof Mesh)) {
    status.value = mesh instanceof Mesh ? "该网格没有 UV0" : "选择一个网格查看 UV0";
    return;
  }
  const index = mesh.geometry.index;
  const triangles = Math.floor((index?.count ?? uv.count) / 3);
  const stride = Math.max(1, Math.ceil(triangles / 30_000));
  status.value = stride > 1 ? `每 ${stride} 个三角面取样一个，边框为 0–1` : "边框为 0–1";
  context.save();
  context.beginPath();
  context.rect(edge, edge, span, span);
  context.clip();
  context.strokeStyle = "#aaf2e3";
  context.globalAlpha = 0.65;
  context.beginPath();
  // 大网格按间隔采样，避免打开 UV 面板时阻塞界面
  for (let triangle = 0; triangle < triangles; triangle += stride) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = triangle * 3 + corner;
      const id = index ? index.getX(vertex) : vertex;
      const x = edge + uv.getX(id) * span;
      const y = edge + (1 - uv.getY(id)) * span;
      if (corner === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
  }
  context.stroke();
  context.restore();
});
</script>

<template>
  <canvas ref="canvas" width="192" height="192" aria-label="UV0 图" />
  <p>{{ status }}</p>
</template>

<style scoped>
canvas { max-width: 100%; height: auto; display: block; margin-top: 6px; border-radius: 4px; }
p { margin: 6px 0; color: #aebdcc; }
</style>

import { Bone, Box3, InstancedMesh, Line, Mesh, Points, Texture, Vector3, type Material, type Object3D } from "three";
import { fileName } from "./model";

export type SceneNode = {
  id: string;
  name: string;
  type: string;
  children: SceneNode[];
};

export type DisplayMode = "original" | "solid" | "wireframe";

export function isRenderable(object: Object3D): object is Mesh | Line | Points {
  return object instanceof Mesh || object instanceof Line || object instanceof Points;
}

export function inspectScene(root: Object3D) {
  const nodes = new Map<string, Object3D>();
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  let bones = 0;

  function visit(object: Object3D): SceneNode {
    nodes.set(object.uuid, object);
    if (object instanceof Bone) bones++;
    if (object instanceof Mesh) {
      const copies = object instanceof InstancedMesh ? object.count : 1;
      const positions = object.geometry.getAttribute("position")?.count ?? 0;
      meshes++;
      vertices += positions * copies;
      triangles += Math.floor((object.geometry.index?.count ?? positions) / 3) * copies;
    }
    return {
      id: object.uuid,
      name: object.name || (object === root ? "模型" : object.type),
      type: object.type,
      children: object.children.map(visit),
    };
  }

  const tree = visit(root);
  // 缓存几何包围盒，初次取景直接复用同一结果
  const box = new Box3().setFromObject(root);
  const size = box.isEmpty() ? null : box.getSize(new Vector3()).toArray();
  return { tree, nodes, meshes, vertices, triangles, size, bones, box };
}

export function inspectMaterials(object?: Object3D, originals?: ReadonlyMap<Mesh, Material | Material[]>) {
  const materials = new Set<Material>();
  object?.traverse((node) => {
    if (!isRenderable(node)) return;
    const source = (node instanceof Mesh ? originals?.get(node) : undefined) ?? node.material;
    for (const material of Array.isArray(source) ? source : [source]) {
      materials.add(material);
    }
  });

  return [...materials].map((material) => ({
    id: material.uuid,
    name: material.name || material.type,
    type: material.type,
    textures: Object.entries(material).flatMap(([slot, texture]) => {
      if (!(texture instanceof Texture)) return [];
      const image = texture.image;
      const url = image?.currentSrc || image?.src;
      const resource = url ? new URL(url, window.location.href).searchParams.get("resource") : null;
      return [{
        texture,
        slot,
        name: resource ? fileName(resource) : texture.name || "内嵌贴图",
        size: image?.width && image?.height ? `${image.width} × ${image.height}` : "未载入",
      }];
    }),
  }));
}

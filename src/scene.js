/**
 * src/scene.js —— 场景装配：几何体 → VAO、物体 → 模型矩阵、光源参数 → 世界坐标
 * ------------------------------------------------------------------
 * 职责边界：
 *   config.js  说"有哪些物体、什么材质、放在哪"
 *   scene.js   把配置变成 GPU 能画的东西（VAO + 模型矩阵），并把面板参数换算成光源位置/方向
 *   renderer.js 只负责"怎么画"（Pass 顺序、uniform 设置）
 *
 * 模型矩阵用教材 lib/MV.js 的 translate / rotate / scale / mult 手工构造（Ch4 变换组合），
 * 这样既满足课程"使用教材配套工具库"，也能在抽问时逐项解释 T·Rz·Ry·Rx·S 的顺序。
 */

import * as Geometry from './geometry.js';
import { OBJECTS, LIGHT_HELPER } from './config.js';
import { createMesh } from './gl-utils.js';
import {
  composeTRS, normalMatrix as computeNormalMatrix, unit3, DEG,
  lookAt, ortho, multiply
} from './mat.js';
import { state } from './state.js';

/**
 * 由 config 里的 {position, rotation(度), scale} 构造模型矩阵。
 * 顺序：M = T · Rz · Ry · Rx · S（先缩放 → 再绕三轴旋转 → 最后平移）
 * 这是教材 Ch4"变换的复合"里最常用的顺序：局部坐标先被摆正，再被放到世界位置。
 */
export function buildModelMatrix(obj) {
  const { position, rotation, scale } = obj.transform;
  const MV = window.MV;
  if (MV && MV.translate && MV.rotate && MV.scale && MV.mult && MV.flatten) {
    let m = MV.scale(scale[0], scale[1], scale[2]);                       // S
    if (rotation[2]) m = MV.mult(MV.rotate(rotation[2], [0, 0, 1]), m);   // Rz
    if (rotation[1]) m = MV.mult(MV.rotate(rotation[1], [0, 1, 0]), m);   // Ry
    if (rotation[0]) m = MV.mult(MV.rotate(rotation[0], [1, 0, 0]), m);   // Rx
    m = MV.mult(MV.translate(position[0], position[1], position[2]), m);  // T
    return new Float32Array(MV.flatten(m));
  }
  // 兜底：MV.js 没加载成功时用 src/mat.js（同样的数学，只是不走教材库）
  return composeTRS(position, rotation, scale);
}

/** 计算物体在自身坐标系里的包围球半径（描边宽度、拾取容差用） */
function boundingRadius(positions) {
  let maxR2 = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const r2 = positions[i] * positions[i] + positions[i + 1] * positions[i + 1] + positions[i + 2] * positions[i + 2];
    if (r2 > maxR2) maxR2 = r2;
  }
  return Math.sqrt(maxR2);
}

/**
 * 创建整个场景的 GPU 资源。
 * @returns {{items: Array, helperSphere: object, totalTriangles: number, dummyVao: object}}
 */
export function createScene(gl) {
  const items = [];
  let totalTriangles = 0;

  OBJECTS.forEach((obj, index) => {
    const type = obj.geometry.type;
    const createFn = Geometry[type];
    if (typeof createFn !== 'function') {
      throw new Error(`config.js 里的几何体类型 "${type}" 在 src/geometry.js 中不存在`);
    }
    const geometry = createFn(...obj.geometry.args);
    const mesh = createMesh(gl, geometry);
    totalTriangles += mesh.triangles;
    const model = buildModelMatrix(obj);
    items.push({
      id: obj.id,
      name: obj.name,
      pickId: index + 1,               // 颜色编码拾取用的 id（1 开始，0 = 背景）
      mesh,
      model,
      normalMatrix: computeNormalMatrix(model),
      radius: boundingRadius(geometry.positions),
      castShadow: obj.castShadow !== false,
      receiveShadow: obj.receiveShadow !== false,
      position: obj.transform.position
    });
  });

  // 光源辅助显示用的小球
  const helperMesh = createMesh(gl, Geometry.sphere(LIGHT_HELPER.pointRadius, 10, 18));

  return { items, helperMesh, totalTriangles };
}

/**
 * 把面板里的光源参数换算成世界空间的光源描述。
 * @returns {{dirDirection: Float32Array, dirColor: number[], point0: Float32Array,
 *            point0Color: number[], point1: Float32Array, point1Color: number[],
 *            ambient: number[]}}
 */
export function lightsForState(s) {
  // 方向光：方位角绕 y 轴、仰角与水平面夹角 → 单位向量（从表面指向光源）
  const az = s.lights.dir.azimuth * DEG;
  const el = s.lights.dir.elevation * DEG;
  const dirDirection = unit3([
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
    Math.cos(el) * Math.sin(az)
  ]);

  // 点光 1：绕场景中心按半径/方位排布，高度可调（默认挂在吊灯罩附近）
  const a1 = s.lights.point1.angle * DEG;
  const point0 = new Float32Array([
    Math.cos(a1) * s.lights.point1.radius,
    s.lights.point1.height,
    Math.sin(a1) * s.lights.point1.radius
  ]);

  // 点光 2：面板直接给 x / z
  const point1 = new Float32Array([s.lights.point2.x, s.lights.point2.height, s.lights.point2.z]);

  const dirColor = [
    s.lights.dir.color[0] * s.lights.dir.intensity,
    s.lights.dir.color[1] * s.lights.dir.intensity,
    s.lights.dir.color[2] * s.lights.dir.intensity
  ];
  const point0Color = [
    s.lights.point1.color[0] * s.lights.point1.intensity,
    s.lights.point1.color[1] * s.lights.point1.intensity,
    s.lights.point1.color[2] * s.lights.point1.intensity
  ];
  const point1Color = [
    s.lights.point2.color[0] * s.lights.point2.intensity,
    s.lights.point2.color[1] * s.lights.point2.intensity,
    s.lights.point2.color[2] * s.lights.point2.intensity
  ];
  const ambient = [
    s.lights.ambient.color[0] * s.lights.ambient.intensity,
    s.lights.ambient.color[1] * s.lights.ambient.intensity,
    s.lights.ambient.color[2] * s.lights.ambient.intensity
  ];

  return { dirDirection, dirColor, point0, point0Color, point1, point1Color, ambient };
}

/**
 * 方向光（太阳）的"光源相机"参数：正交投影覆盖整个庭院。
 * 第一遍阴影渲染用这套 view / proj，第二遍把片元变换到同一空间比较深度。
 *
 * @returns {{position: Float32Array, target: Float32Array, direction: Float32Array,
 *            view: Float32Array, proj: Float32Array, viewProj: Float32Array}}
 */
export function shadowCameraForState(s) {
  const { dirDirection } = lightsForState(s);
  const target = new Float32Array([0.0, 1.2, 0.0]);           // 庭院中心稍高
  const distance = 18.0;
  const position = new Float32Array([
    target[0] + dirDirection[0] * distance,
    target[1] + dirDirection[1] * distance,
    target[2] + dirDirection[2] * distance
  ]);
  // 看向场景中心；up 取 +Y（太阳接近天顶时换一个 up 避免退化）
  const up = Math.abs(dirDirection[1]) > 0.99 ? new Float32Array([0, 0, 1]) : new Float32Array([0, 1, 0]);

  const viewM = lookAt(position, target, up);
  const half = s.shadow.orthoSize;
  const projM = ortho(-half, half, -half, half, 0.5, 44.0);
  const viewProj = multiply(projM, viewM);
  return { position, target, direction: dirDirection, view: viewM, proj: projM, viewProj };
}

/**
 * 每帧根据动画时间推进光源（太阳缓慢移动 / 点光绕场旋转），
 * 全部由 state.display.paused 控制（空格暂停）。
 * 注意：只改 state 里的数值，不碰用户手动调节的强度/颜色。
 */
export function animateLights(s, dt) {
  if (s.display.paused) return;
  // 太阳：极缓慢地绕场景转（0.6°/s），让阴影方向可见地变化
  s.lights.dir.azimuth += dt * 0.6;
  if (s.lights.dir.azimuth > 180) s.lights.dir.azimuth -= 360;
}

/** 点光（阴影用）的远平面与近平面 */
export const POINT_SHADOW_NEAR = 0.05;
export const POINT_SHADOW_FAR = 22.0;

/** 用于点光阴影立方体 6 个面的视图矩阵（+X,-X,+Y,-Y,+Z,-Z） */
export function pointShadowViews(lightPos) {
  const p = lightPos;
  const dirs = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
  ];
  const ups = [
    [0, -1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, -1, 0]
  ];
  return dirs.map((d, i) => {
    const target = new Float32Array([p[0] + d[0], p[1] + d[1], p[2] + d[2]]);
    return { view: lookAt(p, target, new Float32Array(ups[i])), direction: d };
  });
}

/** 供 UI/HUD 显示：选中物体的当前材质 */
export function materialOf(s, id) {
  return s.materials[id] || null;
}

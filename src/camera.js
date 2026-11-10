/**
 * src/camera.js —— 轨道式相机（球坐标环绕）+ 透视/正交投影切换 + 鼠标交互
 * ------------------------------------------------------------------
 * 相机由 4 个参数描述（都在 src/state.js 的 state.camera 里，面板/鼠标都改它）：
 *   azimuth  水平环绕角（弧度）
 *   elevation 仰角（弧度）
 *   distance  到目标点的距离
 *   target    环绕中心
 * 这样相机的 view 矩阵每帧由 lookAt(eye, target, up) 生成，保证"拖动旋转"和
 * "滚轮缩放"都只是改这几个数，渲染器完全无感。
 *
 * 教材对应：Ch5 观察与投影（lookAt / perspective / ortho）。
 */

import { lookAt, perspective, ortho, multiply, invert, unit3, sub3, cross3, DEG } from './mat.js';

/** 相机初始视角（与 state.js 的默认值保持一致，供"重置视角"用） */
export const CAMERA_HOME = {
  projection: 'perspective',
  fov: 55,
  azimuth: 0.78,
  elevation: 0.36,
  distance: 7.6,
  target: [0.0, 1.05, 0.0],
  autoRotate: true,
  orthoScale: 3.9
};

const ELEVATION_MIN = -1.15;
const ELEVATION_MAX = 1.35;
const DISTANCE_MIN = 2.4;
const DISTANCE_MAX = 18.0;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 由 state.camera 计算眼睛位置（世界坐标） */
export function eyePosition(cam) {
  const el = cam.elevation;
  const az = cam.azimuth;
  const d = cam.distance;
  return new Float32Array([
    cam.target[0] + d * Math.cos(el) * Math.cos(az),
    cam.target[1] + d * Math.sin(el),
    cam.target[2] + d * Math.cos(el) * Math.sin(az)
  ]);
}

/**
 * 每帧计算这套矩阵：view / proj / viewProj / invViewProj（天空盒需要逆矩阵）。
 * @param {object} cam   state.camera
 * @param {number} aspect 画布宽高比
 */
export function cameraMatrices(cam, aspect) {
  const eye = eyePosition(cam);
  const target = new Float32Array(cam.target);
  const up = new Float32Array([0, 1, 0]);
  const view = lookAt(eye, target, up);

  let proj;
  if (cam.projection === 'orthographic') {
    const halfH = cam.orthoScale;
    const halfW = halfH * aspect;
    proj = ortho(-halfW, halfW, -halfH, halfH, 0.1, 200.0);
  } else {
    proj = perspective(cam.fov, aspect, 0.05, 200.0);
  }

  const viewProj = multiply(proj, view);
  const invViewProj = invert(viewProj);
  return { eye, target, view, proj, viewProj, invViewProj };
}

/* ================================================================== */
/*  鼠标 / 滚轮交互（main.js 把事件转发到这里）                            */
/* ================================================================== */

/** 左键拖拽：环绕旋转。dx/dy 是像素位移 */
export function orbit(cam, dx, dy) {
  cam.azimuth -= dx * 0.0055;
  cam.elevation = clamp(cam.elevation + dy * 0.0045, ELEVATION_MIN, ELEVATION_MAX);
  // 角度归一到 [-π, π]，避免长时间拖动后数值爆炸
  if (cam.azimuth > Math.PI) cam.azimuth -= Math.PI * 2;
  if (cam.azimuth < -Math.PI) cam.azimuth += Math.PI * 2;
}

/** 滚轮：缩放（对数缩放，手感均匀） */
export function zoom(cam, deltaY) {
  const factor = Math.exp(deltaY * 0.0012);
  cam.distance = clamp(cam.distance * factor, DISTANCE_MIN, DISTANCE_MAX);
}

/** 右键拖拽：平移 target（沿相机右向量 / 上向量，速度随距离缩放） */
export function pan(cam, dx, dy) {
  const eye = eyePosition(cam);
  const forward = unit3(sub3(new Float32Array(cam.target), eye));
  const right = unit3(cross3(forward, new Float32Array([0, 1, 0])));
  const up = cross3(right, forward);
  const scale = cam.distance * 0.0016;
  cam.target[0] += (-right[0] * dx + up[0] * dy) * scale;
  cam.target[1] += (-right[1] * dx + up[1] * dy) * scale;
  cam.target[2] += (-right[2] * dx + up[2] * dy) * scale;
  // 不要把中心点拖到地底下
  cam.target[1] = clamp(cam.target[1], 0.0, 6.0);
}

/** 自动缓慢环绕（空格可暂停：state.display.paused） */
export function autoRotate(cam, dt, paused) {
  if (!cam.autoRotate || paused) return;
  cam.azimuth += dt * 0.12;
  if (cam.azimuth > Math.PI) cam.azimuth -= Math.PI * 2;
}

/** 重置视角到初始值 */
export function resetCamera(cam) {
  Object.assign(cam, {
    projection: CAMERA_HOME.projection,
    fov: CAMERA_HOME.fov,
    azimuth: CAMERA_HOME.azimuth,
    elevation: CAMERA_HOME.elevation,
    distance: CAMERA_HOME.distance,
    target: [...CAMERA_HOME.target],
    autoRotate: CAMERA_HOME.autoRotate,
    orthoScale: CAMERA_HOME.orthoScale
  });
}

/** 正交/透视切换（O 键） */
export function toggleProjection(cam) {
  cam.projection = cam.projection === 'perspective' ? 'orthographic' : 'perspective';
  return cam.projection;
}

/** 屏幕像素坐标 → NDC（拾取时换算用；y 轴翻转） */
export function pixelToNdc(x, y, width, height) {
  return [(x / width) * 2.0 - 1.0, 1.0 - (y / height) * 2.0];
}

/** 度数转弧度（导出给别处用） */
export const deg2rad = DEG;

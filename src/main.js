/**
 * src/main.js —— 应用入口：初始化 WebGL / 渲染器 / 面板、绑定输入、主循环
 * ------------------------------------------------------------------
 * 启动流程：
 *   1) 检查 WebGL 2.0 支持；
 *   2) 异步创建渲染器（编译着色器 + 生成几何体 + 加载纹理与环境贴图）；
 *   3) 初始化参数面板（src/ui.js 按 src/ui-schema.js 生成）；
 *   4) 支持 URL 参数：
 *        ?preset=overview|combo-ambient|...   直接套用一个预设（README 截图用）
 *        ?hideui=1                            隐藏面板/HUD，方便截纯画面
 *   5) requestAnimationFrame 主循环：推进动画 → 渲染 → 更新 HUD。
 *
 * 交互约定见 CONTRACT.md 第 7 节 / index.html 的 #help。
 */

import { createContext } from './gl-utils.js';
import { createRenderer } from './renderer.js';
import { state, resetState, applyPreset } from './state.js';
import { PANEL_SCHEMA } from './ui-schema.js';
import {
  initUI, syncUI, refreshDynamicGroups, setHud, showToast, togglePanelCollapsed
} from './ui.js';
import {
  orbit, zoom, pan, autoRotate, resetCamera, toggleProjection
} from './camera.js';
import { animateLights } from './scene.js';

const canvas = document.getElementById('gl-canvas');
const loadingText = document.getElementById('loading-text');
const errorBox = document.getElementById('error-box');
const errorText = document.getElementById('error-text');

let renderer = null;
let lastTime = 0;
let fpsAccum = 0;
let fpsFrames = 0;
let hudTimer = 0;

/* ================================================================== */
/*  错误提示                                                            */
/* ================================================================== */
function showError(message) {
  console.error(message);
  if (errorBox) {
    errorBox.style.display = 'flex';
    if (errorText) errorText.textContent = message;
  }
  document.body.classList.add('loaded');
}

/* ================================================================== */
/*  分屏标签（E1 法线对比 2 栏 / E3 着色模型对比 3 栏）                     */
/* ================================================================== */
function updateCompareLabels() {
  const label = document.getElementById('compare-label');
  const a = document.getElementById('cmp-a');
  const b = document.getElementById('cmp-b');
  const c = document.getElementById('cmp-c');
  if (!label || !a || !b || !c) return;

  const twoCol = state.compare.normal && !state.compare.split;
  const threeCol = state.compare.split;

  if (!twoCol && !threeCol) {
    document.body.classList.remove('compare-split');
    document.body.classList.remove('compare-two');
    return;
  }
  document.body.classList.add('compare-split');
  document.body.classList.toggle('compare-two', twoCol);
  label.style.display = 'flex';

  if (threeCol) {
    a.textContent = '① Phong（R·V）';
    b.textContent = '② Blinn–Phong（N·H）';
    c.textContent = '③ Toon 卡通着色';
    c.style.display = '';
    a.style.flex = b.style.flex = c.style.flex = '1';
  } else {
    a.textContent = '① 平滑法线（无法线贴图）';
    b.textContent = '② 法线贴图 E1（凹凸细节）';
    c.textContent = '';
    c.style.display = 'none';
    a.style.flex = b.style.flex = '1';
  }
}

/* ================================================================== */
/*  选中物体                                                            */
/* ================================================================== */
function selectObject(item) {
  if (!item) {
    if (state.selectedId !== null) {
      state.selectedId = null;
      state.selectedName = '—';
      refreshDynamicGroups();
      syncUI();
      updateCompareLabels();
    }
    return;
  }
  state.selectedId = item.id;
  state.selectedName = item.name;
  refreshDynamicGroups();
  syncUI();
  updateCompareLabels();
  showToast(`已选中：${item.name}`);
}

/** 供截图脚本按 id 选中（不需要真的点屏幕） */
function selectById(id) {
  const item = renderer ? renderer.scene.items.find((it) => it.id === id) : null;
  selectObject(item || null);
}

/* ================================================================== */
/*  面板按钮回调                                                         */
/* ================================================================== */
function onAction(action) {
  switch (action) {
    case 'resetCamera':
      resetCamera(state.camera);
      showToast('视角已重置');
      break;
    case 'clearSelection':
      selectObject(null);
      break;
    case 'screenshot': {
      if (!renderer) break;
      const url = renderer.screenshot();
      const link = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      link.href = url;
      link.download = `AP3-光照与纹理-${stamp}.png`;
      link.click();
      showToast('已保存当前画面');
      break;
    }
    case 'resetAll':
      resetState();
      refreshDynamicGroups();
      showToast('已恢复默认参数');
      break;
    default:
      break;
  }
  syncUI();
  updateCompareLabels();
}

/** 面板控件变化后的副作用（目前主要是分屏标签、阴影模式提示） */
function onChange(path) {
  if (path && (path.startsWith('compare') || path === 'shading' || path === 'shadow.mode')) {
    updateCompareLabels();
  }
}

/* ================================================================== */
/*  键盘快捷键                                                          */
/* ================================================================== */
function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

function onKeyDown(event) {
  if (isEditableTarget(event.target)) return;
  const key = event.key;
  const lower = key.toLowerCase();
  let changed = true;

  switch (lower) {
    case '1': state.shading = 'phong'; break;
    case '2': state.shading = 'blinn'; break;
    case '3': state.shading = 'toon'; break;
    case 'a': state.phong.ambient = !state.phong.ambient; break;
    case 'd': state.phong.diffuse = !state.phong.diffuse; break;
    case 's': state.phong.specular = !state.phong.specular; break;
    case 'l': state.lights.dir.enabled = !state.lights.dir.enabled; break;
    case 'p':
      state.lights.point1.enabled = !state.lights.point1.enabled;
      state.lights.point2.enabled = state.lights.point1.enabled;
      break;
    case 'h': state.shadow.enabled = !state.shadow.enabled; break;
    case 'n': state.textures.normalMap = !state.textures.normalMap; break;
    case 'c': state.textures.cubemap = !state.textures.cubemap; break;
    case 't': {
      const on = !state.textures.floor;
      state.textures.floor = on;
      state.textures.crate = on;
      state.textures.wall = on;
      break;
    }
    case 'x':
      state.compare.split = !state.compare.split;
      if (state.compare.split) state.compare.normal = false;
      break;
    case 'f': state.display.wireframe = !state.display.wireframe; break;
    case 'o': toggleProjection(state.camera); break;
    case 'r': resetCamera(state.camera); break;
    case 'escape': selectObject(null); break;
    case ' ':
      event.preventDefault();
      state.display.paused = !state.display.paused;
      showToast(state.display.paused ? '动画已暂停' : '动画继续');
      break;
    case '?':
      toggleHelp();
      break;
    default:
      changed = false;
  }

  if (changed) {
    syncUI();
    updateCompareLabels();
  }
}

function toggleHelp() {
  const details = document.querySelector('#help details');
  if (details) details.open = !details.open;
}

/* ================================================================== */
/*  鼠标 / 滚轮交互                                                     */
/* ================================================================== */
let dragState = null;   // { button, lastX, lastY, moved }

function bindPointerEvents() {
  if (!canvas) return;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    dragState = { button: e.button, lastX: e.clientX, lastY: e.clientY, moved: 0 };
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.lastX;
    const dy = e.clientY - dragState.lastY;
    dragState.lastX = e.clientX;
    dragState.lastY = e.clientY;
    dragState.moved += Math.abs(dx) + Math.abs(dy);

    if (dragState.button === 0) {
      orbit(state.camera, dx, dy);
    } else if (dragState.button === 2 || dragState.button === 1) {
      pan(state.camera, dx, dy);
    }
  });

  const endDrag = (e) => {
    if (!dragState) return;
    const wasClick = dragState.button === 0 && dragState.moved < 5;
    dragState = null;
    canvas.style.cursor = 'grab';
    if (wasClick && renderer) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const item = renderer.pickAtCss(x, y);
      selectObject(item);
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { dragState = null; canvas.style.cursor = 'grab'; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom(state.camera, e.deltaY);
  }, { passive: false });

  canvas.style.cursor = 'grab';
}

/* ================================================================== */
/*  HUD 刷新                                                           */
/* ================================================================== */
function updateHud(fps) {
  const shadingLabel = { phong: 'Phong', blinn: 'Blinn–Phong', toon: 'Toon' }[state.shading] || state.shading;
  const shadowLabel = state.shadow.enabled
    ? `${state.shadow.mode === 'dir' ? '方向光' : '点光立方体'} ${state.shadow.resolution}²${state.shadow.pcf ? ' PCF' : ''}`
    : '关闭';
  setHud({
    fps: `${fps.toFixed(0)} FPS`,
    tris: `${(state.stats.tris / 1000).toFixed(1)}k 三角形 · ${state.stats.drawCalls} draw`,
    selected: state.selectedId ? state.selectedName : '未选中（单击物体选中）',
    shading: state.compare.split ? `${shadingLabel}（三联对比）` : shadingLabel,
    shadow: shadowLabel,
    gpu: state.stats.gpu
  });
}

/* ================================================================== */
/*  主循环                                                             */
/* ================================================================== */
function frame(now) {
  const dt = Math.min(0.05, lastTime ? (now - lastTime) / 1000 : 0.016);
  lastTime = now;

  // 动画推进：太阳缓慢移动 + 吊灯点光绕场 + 相机自动环绕（空格可暂停）
  animateLights(state, dt);
  autoRotate(state.camera, dt, state.display.paused);

  if (renderer) {
    try {
      renderer.renderFrame();
      state.stats.fps = state.stats.fps ? state.stats.fps * 0.9 + (1 / Math.max(dt, 1e-3)) * 0.1 : 1 / Math.max(dt, 1e-3);
    } catch (err) {
      showError(`渲染出错：${err.message}`);
      return;
    }
  }

  // FPS 统计 + HUD 每 250ms 刷新一次（避免 DOM 抖动）
  fpsAccum += dt;
  fpsFrames += 1;
  hudTimer += dt;
  if (hudTimer > 0.25) {
    const fps = fpsFrames / Math.max(fpsAccum, 1e-4);
    updateHud(fps);
    fpsAccum = 0;
    fpsFrames = 0;
    hudTimer = 0;
  }

  requestAnimationFrame(frame);
}

/* ================================================================== */
/*  启动                                                               */
/* ================================================================== */
async function main() {
  if (!canvas) {
    showError('找不到 #gl-canvas 画布元素');
    return;
  }

  // 1) WebGL 2.0 支持检查
  const gl = createContext(canvas);
  if (!gl) {
    showError('当前浏览器不支持 WebGL 2.0。请使用较新的 Chrome / Edge / Firefox 打开，并通过静态服务器访问。');
    return;
  }
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  if (debugInfo) {
    state.stats.gpu = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '—';
  } else {
    state.stats.gpu = gl.getParameter(gl.VERSION) || '—';
  }
  if (!gl.getExtension('EXT_color_buffer_float')) {
    // 深度纹理不依赖这个扩展，仅作为提示
    console.info('[AP3] 未检测到 EXT_color_buffer_float（本项目不依赖它）');
  }

  // 2) 面板先建好（加载过程中用户就能看到面板骨架）
  try {
    initUI({ schema: PANEL_SCHEMA, onAction, onChange });
  } catch (err) {
    console.warn('面板初始化失败：', err);
  }

  // 3) 渲染器（异步：着色器 + 几何体 + 纹理）
  try {
    renderer = await createRenderer(gl, canvas, {
      onProgress: (p, msg) => {
        if (loadingText) {
          loadingText.textContent = msg ? `${msg}（${Math.round(p * 100)}%）` : `正在加载…（${Math.round(p * 100)}%）`;
        }
      }
    });
  } catch (err) {
    showError(`初始化失败：${err.message}`);
    return;
  }

  // 4) 输入与 HUD
  bindPointerEvents();
  window.addEventListener('keydown', onKeyDown);

  // URL 参数：预设 / 隐藏 UI（README 截图与现场演示用）
  const params = new URLSearchParams(window.location.search);
  if (params.has('preset')) {
    const name = params.get('preset');
    if (!applyPreset(name)) console.warn(`未知预设：${name}`);
  }

  // 纯画面截图用的样式规则：body.ui-hidden 时隐藏面板/标题/HUD/帮助（保留分屏标签）
  const uiStyle = document.createElement('style');
  uiStyle.textContent =
    'body.ui-hidden #panel,body.ui-hidden #title-bar,body.ui-hidden #hud,body.ui-hidden #help{display:none!important}' +
    'body.ui-hidden #toast{display:none!important}' +
    'body.ui-hidden #compare-label{left:20px!important}';
  document.head.appendChild(uiStyle);
  if (params.get('hideui') === '1') document.body.classList.add('ui-hidden');

  syncUI();
  refreshDynamicGroups();
  updateCompareLabels();
  updateHud(0);

  // 5) 隐藏加载遮罩，开始主循环
  document.body.classList.add('loaded');
  requestAnimationFrame(frame);

  // 6) 暴露调试 / 截图接口（tools/capture.mjs 用 CDP 调用）
  window.AP3 = {
    state,
    gl,
    applyPreset,
    resetState,
    syncUI,
    refreshDynamicGroups,
    selectById,
    updateCompareLabels,
    renderFrame: () => renderer.renderFrame(),
    get renderer() { return renderer; },
    ready: true
  };
  window.__AP3_READY__ = true;
}

main().catch((err) => showError(`启动失败：${err.message}`));

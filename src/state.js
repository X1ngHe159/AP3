/**
 * src/state.js —— 全局可变状态（唯一真值源）
 * ------------------------------------------------------------------
 * 面板控件、键盘快捷键、URL 预设（?preset=xxx）都只修改这个对象；
 * 每帧渲染循环直接读它，所以「改参数 → 下一帧立刻生效」。
 *
 * 导出：
 *   state             单例，所有模块共享
 *   resetState()      恢复默认（保留 stats）
 *   applyPreset(name) 应用一个预设（README 截图用，保证可复现）
 *   getPath / setPath / resolvePath  点号路径反射读写（ui.js 用）
 *   PRESETS           预设表
 */
import { buildMaterials, OBJECTS } from './config.js';

/** 默认状态（深拷贝模板，resetState 从这里恢复） */
function createDefaults() {
  return {
    /* ---------- 相机：轨道式（球坐标）控制器 ---------- */
    camera: {
      projection: 'perspective', // 'perspective' | 'orthographic'
      fov: 55,                   // 透视：垂直视场角（度）
      azimuth: 0.75,             // 水平环绕角（弧度）
      elevation: 0.34,           // 仰角（弧度）
      distance: 9.0,             // 到 target 的距离
      target: [0.0, 1.0, 0.0],   // 环绕中心
      autoRotate: true,          // 自动缓慢环绕（空格暂停整个动画）
      orthoScale: 3.9            // 正交投影半高
    },

    /* ---------- 光源 ---------- */
    lights: {
      ambient: { intensity: 0.32, color: [1.0, 1.0, 1.0] },
      dir: {                     // 方向光（太阳）
        enabled: true,
        azimuth: 70,             // 度：绕 y 轴方位
        elevation: 46,           // 度：与水平面夹角
        intensity: 1.45,
        color: [1.0, 0.95, 0.86]
      },
      point1: {                  // 点光 1：庭院灯（在灯罩下方）
        enabled: true,
        angle: 24,               // 度：绕场景中心的角度
        height: 1.62,
        radius: 1.85,
        intensity: 1.35,
        color: [1.0, 0.60, 0.30]
      },
      point2: {                  // 点光 2：冷色补光
        enabled: true,
        x: -2.10,
        z: 1.60,
        height: 0.90,
        intensity: 0.70,
        color: [0.42, 0.66, 1.0]
      }
    },

    /* ---------- Phong 三分量：独立开关 + 全局缩放 ---------- */
    phong: {
      ambient: true,
      diffuse: true,
      specular: true,
      // 环境分量倍率：环境光本身很弱（现实里靠天光），默认放大 2.5 倍让背光面不至于全黑
      ambientScale: 2.5,
      diffuseScale: 1.0,
      specularScale: 1.0
    },

    /* ---------- 每个物体的材质（初值来自 config.js） ---------- */
    materials: buildMaterials(),

    /* ---------- 拾取选中 ---------- */
    selectedId: null,
    selectedName: '—',

    /* ---------- 纹理与环境贴图 ---------- */
    textures: {
      floor: true,
      crate: true,
      wall: true,
      normalMap: true,
      normalStrength: 1.6,
      cubemap: true,
      skybox: true,
      reflectionStrength: 0.85,
      modulate: true
    },

    /* ---------- 阴影贴图 ---------- */
    shadow: {
      enabled: true,
      mode: 'dir',        // 'dir' 方向光阴影 | 'point' 点光立方体阴影（E2）
      resolution: 2048,   // 1024 | 2048 | 4096
      orthoSize: 7.0,     // 方向光正交视锥半宽
      bias: 0.0035,
      pcf: true,
      softness: 1.8,
      showMap: false      // 右下角显示深度图小窗
    },

    /* ---------- 着色模型 / 扩展对比 ---------- */
    shading: 'phong',     // 'phong' | 'blinn' | 'toon'
    compare: {
      split: false,       // 选做 E3：Phong / Blinn-Phong / Toon 三联分屏
      normal: false       // 选做 E1：法线贴图左右分屏（左平滑法线 / 右法线贴图）
    },

    /* ---------- 显示选项 ---------- */
    display: {
      wireframe: false,
      lightHelpers: false,
      pickDebug: false,
      paused: false,
      // 调试可视化：0 = 正常渲染, 1 = 输出方向光阴影因子（白=亮/黑=影）, 2 = 输出光源空间 UV
      debugMode: 0
    },

    /* ---------- 统计（渲染循环写） ---------- */
    stats: { fps: 0, gpu: '—', tris: 0, drawCalls: 0 }
  };
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }
  return value;
}

export const state = createDefaults();

/** 恢复默认状态（保留 stats 里的 GPU 信息，避免闪一下 "—"） */
export function resetState() {
  const fresh = createDefaults();
  fresh.stats.gpu = state.stats.gpu;
  fresh.stats.fps = state.stats.fps;
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, fresh);
}

/* ================================================================== */
/*  点号路径反射读写（面板控件用）：支持 'phong.ambient'、'materials.*.shininess' */
/* ================================================================== */

/**
 * 把路径里的 `*` 解析为当前选中物体的 id。
 * 没有选中物体时返回 null —— 调用方据此把控件禁用。
 */
export function resolvePath(path) {
  if (!path.includes('*')) return path;
  const id = state.selectedId;
  if (!id) return null;
  return path.replace(/\*/g, id);
}

/** 读点号路径的值；路径含 `*` 但未选中物体时返回 undefined */
export function getPath(path) {
  const resolved = resolvePath(path);
  if (!resolved) return undefined;
  const parts = resolved.split('.');
  let cur = state;
  for (const part of parts) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** 写点号路径的值（中间层不存在时自动创建） */
export function setPath(path, value) {
  const resolved = resolvePath(path);
  if (!resolved) return false;
  const parts = resolved.split('.');
  const last = parts.pop();
  let cur = state;
  for (const part of parts) {
    if (typeof cur[part] !== 'object' || cur[part] === null) cur[part] = {};
    cur = cur[part];
  }
  cur[last] = value;
  return true;
}

/* ================================================================== */
/*  预设：URL ?preset=xxx 触发，用于 README 截图 / 现场快速演示         */
/*  每个预设只改 state，不改任何渲染代码；相机固定 → 截图可复现         */
/* ================================================================== */

/** 把所有物体材质恢复默认（预设里先调用，保证干净起点） */
function resetMaterialsToDefaults() {
  const fresh = buildMaterials();
  for (const id of Object.keys(state.materials)) {
    Object.assign(state.materials[id], fresh[id]);
  }
}

/** 固定一个「庭院总览」机位（截图用） */
function fixedOverview() {
  state.camera.projection = 'perspective';
  state.camera.fov = 55;
  state.camera.azimuth = 0.78;
  state.camera.elevation = 0.34;
  state.camera.distance = 9.2;
  state.camera.target = [0.0, 1.0, 0.0];
  state.camera.autoRotate = false;
  state.display.paused = true;
}

/** 只保留指定的 Phong 分量 */
function onlyComponents(ambient, diffuse, specular) {
  state.phong.ambient = ambient;
  state.phong.diffuse = diffuse;
  state.phong.specular = specular;
  const ambientOnly = ambient && !diffuse && !specular;
  if (ambientOnly) {
    // 只开环境光时整体亮度极低（这正是环境光"均匀但无立体感"的特点），
    // 为了让对比图能看清物体轮廓，这一张把环境光强度与倍率调高（README 会注明）
    state.phong.ambientScale = 6.0;
    state.lights.ambient.intensity = 1.0;
  } else {
    state.phong.ambientScale = 2.5;
    state.lights.ambient.intensity = 0.32;
  }
  state.phong.diffuseScale = 1.0;
  state.phong.specularScale = 1.0;
  state.selectedId = 'mirrorSphere';
  state.selectedName = '反射球（环境贴图）';
}

export const PRESETS = {
  /* 默认总览 */
  overview(state) {
    fixedOverview();
    resetMaterialsToDefaults();
    state.shading = 'phong';
    state.compare.split = false;
    state.shadow.enabled = true;
    state.shadow.mode = 'dir';
    state.textures.cubemap = true;
    state.textures.skybox = true;
  },

  /* ---------- README：Phong 三分量四种组合 ---------- */
  'combo-ambient'(state) {
    fixedOverview();
    resetMaterialsToDefaults();
    onlyComponents(true, false, false);
    state.shadow.enabled = false;
    state.textures.cubemap = false;
    state.textures.skybox = false;
  },
  'combo-diffuse'(state) {
    fixedOverview();
    resetMaterialsToDefaults();
    onlyComponents(false, true, false);
    state.shadow.enabled = false;
    state.textures.cubemap = false;
    state.textures.skybox = false;
  },
  'combo-specular'(state) {
    fixedOverview();
    resetMaterialsToDefaults();
    onlyComponents(false, false, true);
    state.shadow.enabled = false;
    state.textures.cubemap = false;
    state.textures.skybox = false;
  },
  'combo-all'(state) {
    fixedOverview();
    resetMaterialsToDefaults();
    onlyComponents(true, true, true);
    state.shadow.enabled = true;
    state.shadow.mode = 'dir';
    state.textures.cubemap = true;
    state.textures.skybox = true;
  },

  /* ---------- 必做项各自的展示机位 ---------- */
  shadow(state) {
    fixedOverview();
    resetMaterialsToDefaults();
    state.shadow.enabled = true;
    state.shadow.mode = 'dir';
    state.shadow.resolution = 2048;
    state.shadow.orthoSize = 7.0;
    state.shadow.bias = 0.0035;
    state.shadow.pcf = true;
    state.camera.elevation = 0.30;
    state.camera.distance = 9.0;
  },
  'shadow-debug'(state) {
    // 故意把 bias 设为 0、正交视锥缩小，并打开深度图小窗：
    // 用来说明"为什么需要 bias / PCF"，README 里与 06-shadow 做对比
    PRESETS.shadow(state);
    state.shadow.showMap = true;
    state.shadow.bias = 0.0;
    state.shadow.orthoSize = 4.2;
    state.camera.distance = 6.2;
  },
  'picking'(state) {
    fixedOverview();
    resetMaterialsToDefaults();
    state.selectedId = 'crate';
    state.selectedName = '板条箱';
    state.camera.azimuth = 0.62;
    state.camera.elevation = 0.30;
    state.camera.distance = 6.0;
    state.camera.target = [1.2, 0.9, -0.6];
  },
  'uv-dataflow'(state) {
    fixedOverview();
    resetMaterialsToDefaults();
    state.selectedId = 'tileCube';
    state.selectedName = 'UV 棋盘方块';
    state.camera.azimuth = 0.95;
    state.camera.elevation = 0.28;
    state.camera.distance = 3.2;
    state.camera.target = [3.4, 0.4, 1.1];
    state.shadow.enabled = false;
  },
  'reflection'(state) {
    fixedOverview();
    resetMaterialsToDefaults();
    state.camera.azimuth = 0.25;
    state.camera.elevation = 0.22;
    state.camera.distance = 3.6;
    state.camera.target = [-2.35, 1.05, -1.35];
    state.selectedId = 'mirrorSphere';
    state.selectedName = '反射球（环境贴图）';
  },

  /* ---------- 选做 E1 / E2 / E3 ---------- */
  'extension-e1'(state) {  // 法线贴图对比：左侧关闭、右侧开启（分屏由渲染器按 compare.normal 处理）
    fixedOverview();
    resetMaterialsToDefaults();
    state.camera.azimuth = 0.55;
    state.camera.elevation = 0.20;
    state.camera.distance = 3.1;
    state.camera.target = [1.85, 0.75, -0.9];
    state.textures.normalMap = true;
    state.textures.normalStrength = 1.6;
    state.compare.normal = true;         // 左右分屏：左 = 平滑法线，右 = 法线贴图
    state.shadow.enabled = false;
  },
  'extension-e2'(state) {  // 透明混合 + 点光阴影
    fixedOverview();
    resetMaterialsToDefaults();
    state.camera.azimuth = 0.40;
    state.camera.elevation = 0.26;
    state.camera.distance = 4.6;
    state.camera.target = [-0.9, 0.7, 1.0];
    state.shadow.enabled = true;
    state.shadow.mode = 'point';         // 点光源立方体阴影贴图
    state.shadow.resolution = 1024;
    state.selectedId = 'glassSphere';
    state.selectedName = '玻璃球（透明混合 E2）';
  },
  'extension-e3'(state) {  // 三种着色模型三联对比
    fixedOverview();
    resetMaterialsToDefaults();
    state.compare.split = true;
    state.shading = 'phong';
    state.camera.azimuth = 0.62;
    state.camera.elevation = 0.30;
    state.camera.distance = 5.4;
    state.camera.target = [0.6, 0.9, 0.0];
  },

  'wireframe'(state) {
    fixedOverview();
    resetMaterialsToDefaults();
    state.display.wireframe = true;
  },
  'light-helpers'(state) {
    fixedOverview();
    resetMaterialsToDefaults();
    state.display.lightHelpers = true;
  }
};

/** 应用预设；返回是否命中 */
export function applyPreset(name) {
  const fn = PRESETS[name];
  if (!fn) return false;
  fn(state);
  // 预设执行后统一做的收尾：清掉未选中的高亮信息
  if (state.selectedId) {
    const obj = OBJECTS.find((o) => o.id === state.selectedId);
    state.selectedName = obj ? obj.name : '—';
  }
  return true;
}

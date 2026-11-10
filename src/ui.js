/**
 * src/ui.js —— 通用参数面板引擎（数据驱动渲染）
 * ------------------------------------------------------------------
 * src/ui-schema.js 用纯数据描述面板控件，这里把它生成成 DOM 并和 src/state.js 双向绑定：
 *   schema → 生成 DOM → 用户操作 → setPath(state, path, value) → onChange(path, value)
 *   state  → 面板：syncUI() 全量回填（拾取 / 键盘 / 预设之后调用）
 * 选中物体变化：main.js 调 refreshDynamicGroups() 重建材质组，再调 syncUI()。
 *
 * 导出：initUI / syncUI / refreshDynamicGroups / setHud / showToast / togglePanelCollapsed
 * 键盘快捷键不在这里处理（由 src/main.js 统一监听）。
 */

import { state, getPath, setPath, resolvePath, resetState } from './state.js';

/* ================================================================== */
/*  模块级私有状态（不挂 window，避免全局污染）                        */
/* ================================================================== */

let panelEl = null;        // #panel 容器
let onChangeCb = null;     // onChange(path, value, resolvedPath)
let onActionCb = null;     // onAction(action, item)
let staticEntries = [];    // 静态分组的控件登记表
let dynamicGroups = [];    // [{ def, section, entries }]，动态分组（材质）
let toastTimer = 0;        // toast 自动隐藏计时器

/** 动态组未选中物体时的提示语 */
const MATERIAL_EMPTY_HINT = '单击画面中的物体以编辑材质';

/* ================================================================== */
/*  小工具                                                            */
/* ================================================================== */

/** 创建元素的小助手：tag + 可选 class + 可选文本 */
function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** [r,g,b]（0..1 浮点）→ '#rrggbb' */
function rgbToHex(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return '#000000';
  return '#' + rgb.slice(0, 3).map((c) => {
    const n = Math.round(Math.min(1, Math.max(0, Number(c) || 0)) * 255);
    return n.toString(16).padStart(2, '0');
  }).join('');
}

/** '#rrggbb' → [r,g,b]（0..1 浮点） */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** range 的显示文本：format(value) + unit（format 抛错时退化为原值） */
function formatRange(item, value) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '—';
  let text;
  try {
    text = typeof item.format === 'function' ? item.format(value) : String(value);
  } catch (err) {
    text = String(value);
  }
  return text + (item.unit || '');
}

/** 大数字加千分位（三角形数量） */
function formatCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  return value === undefined || value === null || value === '' ? '—' : String(value);
}

/** 写回 state 并回调 main.js；路径含 * 但未选中物体时直接忽略 */
function commit(item, value) {
  if (!item.path) return;
  const resolved = resolvePath(item.path);
  if (!resolved) return;
  if (setPath(item.path, value) && onChangeCb) onChangeCb(item.path, value, resolved);
}

/* ================================================================== */
/*  六种控件生成器：返回要插入 <section class="group"> 的元素          */
/* ================================================================== */

/** range：.row 里 label + 滑块 + output */
function makeRange(item, registry) {
  const row = h('label', 'row');
  const input = h('input');
  input.type = 'range';
  input.id = item.id; // 沿用 schema id，capture 脚本按 #id 精确操作
  for (const key of ['min', 'max', 'step']) if (item[key] !== undefined) input[key] = item[key];
  const output = h('output');
  output.id = item.id + '-val';
  row.append(h('span', 'label', item.label), input, output);
  input.addEventListener('input', () => {
    // 滑条永远是数值：即使 schema 没写 numeric:true 也要 Number()，否则 state 混入字符串
    const value = Number(input.value);
    commit(item, value);
    output.textContent = formatRange(item, value);
  });
  registry.push({ kind: 'range', item, el: input, output });
  return row;
}

/** checkbox：.check 里 checkbox + 文字 */
function makeCheckbox(item, registry) {
  const row = h('label', 'check');
  const input = h('input');
  input.type = 'checkbox';
  input.id = item.id;
  row.append(input, h('span', undefined, item.label));
  input.addEventListener('change', () => commit(item, input.checked));
  registry.push({ kind: 'checkbox', item, el: input });
  return row;
}

/** select：.row 里 label + select；numeric:true 时把 value 转 Number 写回 */
function makeSelect(item, registry) {
  const row = h('div', 'row');
  const select = h('select');
  select.id = item.id;
  for (const opt of item.options || []) {
    const option = h('option', undefined, opt.label);
    option.value = String(opt.value);
    select.appendChild(option);
  }
  select.addEventListener('change', () => commit(item, item.numeric ? Number(select.value) : select.value));
  row.append(h('span', 'label', item.label), select);
  registry.push({ kind: 'select', item, el: select });
  return row;
}

/** color：.row.color-row + <input type="color">；写回 [r,g,b]（0..1 浮点） */
function makeColor(item, registry) {
  const row = h('div', 'row color-row');
  const input = h('input');
  input.type = 'color';
  input.id = item.id;
  input.addEventListener('input', () => commit(item, hexToRgb(input.value)));
  row.append(h('span', 'label', item.label), input);
  registry.push({ kind: 'color', item, el: input });
  return row;
}

/** button：由 buildGroup 统一放进 .btn-grid；点击回调 onAction(action) */
function makeButton(item) {
  const button = h('button', undefined, item.label);
  button.type = 'button';
  button.id = item.id;
  button.addEventListener('click', () => {
    if (onActionCb) onActionCb(item.action, item);
  });
  return button;
}

/** info：.info-row 里 .label + .info-val（syncUI 时用 text(state) 刷新） */
function makeInfo(item, registry) {
  const row = h('div', 'info-row');
  const val = h('span', 'info-val', '—');
  val.id = item.id;
  row.append(h('span', 'label', item.label), val);
  registry.push({ kind: 'info', item, el: val });
  return row;
}

/** 控件类型 → 生成函数（新增类型：schema 加对象 + 这里加一条） */
const BUILDERS = { range: makeRange, checkbox: makeCheckbox, select: makeSelect, color: makeColor, info: makeInfo };

/* ================================================================== */
/*  分组生成                                                           */
/* ================================================================== */

/** 动态组（dynamic:'material'）未选中物体时：显示提示 + 禁用整组控件 */
function applyDynamicState(def, section) {
  if (!def.dynamic) return;
  const empty = !state.selectedId;
  section.classList.toggle('group-empty', empty);
  const hint = section.querySelector(':scope > .hint');
  if (hint) hint.textContent = empty ? MATERIAL_EMPTY_HINT : (def.hint || '');
  // 按钮没有 path，必须在这里统一禁用；输入控件 syncEntry 会再按 path 精确一次
  section.querySelectorAll('input, select, button').forEach((el) => {
    el.disabled = empty;
  });
}

/** 按 group 定义生成 <section class="group">，控件登记到 registry */
function buildGroup(def, registry) {
  const section = h('section', 'group');
  section.id = 'group-' + def.id;
  section.dataset.groupId = def.id;
  if (def.collapsed) section.classList.add('collapsed');

  const title = h('h3', undefined, def.title);
  title.title = '点击折叠 / 展开该分组';
  title.addEventListener('click', () => section.classList.toggle('collapsed'));
  section.appendChild(title);

  let btnGrid = null; // 连续的 button 合并到同一个 .btn-grid，两列排布
  for (const item of def.items || []) {
    if (item.type === 'button') {
      if (!btnGrid) {
        btnGrid = h('div', 'btn-grid');
        section.appendChild(btnGrid);
      }
      btnGrid.appendChild(makeButton(item));
      continue;
    }
    btnGrid = null; // 非按钮打断按钮分组
    const builder = BUILDERS[item.type];
    if (!builder) {
      console.warn('[ui] 未知控件类型：', item.type, item.id);
      continue;
    }
    section.appendChild(builder(item, registry));
  }

  if (def.hint) section.appendChild(h('p', 'hint', def.hint)); // .hint 永远在分组末尾
  if (def.dynamic) applyDynamicState(def, section);
  return section;
}

/* ================================================================== */
/*  从 state 回填单个控件                                              */
/* ================================================================== */

function syncEntry(entry) {
  const { kind, item, el, output } = entry;
  const raw = item.path ? getPath(item.path) : undefined;

  // 路径含 * 但未选中物体 → getPath 返回 undefined → 禁用该控件
  if (item.path && raw === undefined) {
    if ('disabled' in el) el.disabled = true;
    if (output) output.textContent = '—';
    return;
  }
  if ('disabled' in el) el.disabled = false;

  switch (kind) {
    case 'range': {
      const value = Number(raw);
      if (Number.isFinite(value)) el.value = String(value);
      if (output) output.textContent = formatRange(item, raw);
      break;
    }
    case 'checkbox':
      el.checked = Boolean(raw);
      break;
    case 'select':
      el.value = String(raw);
      break;
    case 'color':
      el.value = rgbToHex(raw);
      break;
    case 'info': {
      let text = '—';
      try {
        const result = item.text(state);
        text = result === undefined || result === null ? '—' : String(result);
      } catch (err) {
        text = '—';
      }
      el.textContent = text;
      break;
    }
    default:
      break;
  }
}

/* ================================================================== */
/*  对外导出                                                           */
/* ================================================================== */

/**
 * 初始化参数面板：清空旧分组 → 按 schema 生成 → 绑定折叠按钮 → 首次 syncUI()
 * @param {object}   options
 * @param {object}   options.schema   src/ui-schema.js 的 PANEL_SCHEMA
 * @param {Function} options.onAction (action, item) 按钮回调
 * @param {Function} options.onChange (path, value, resolvedPath) 控件变化回调
 */
export function initUI(options = {}) {
  const schema = options && options.schema;
  if (!schema || !Array.isArray(schema.groups)) {
    throw new Error('[ui] initUI 需要传入 { schema: PANEL_SCHEMA }');
  }
  onChangeCb = typeof options.onChange === 'function' ? options.onChange : null;
  onActionCb = typeof options.onAction === 'function' ? options.onAction : null;

  panelEl = document.getElementById('panel');
  if (!panelEl) throw new Error('[ui] 页面缺少 #panel 容器');

  // 只清理上一次生成的 .group，保留 HTML 里的 .panel-head 骨架
  panelEl.querySelectorAll(':scope > .group').forEach((node) => node.remove());
  staticEntries = [];
  dynamicGroups = [];

  for (const def of schema.groups) {
    const registry = [];
    const section = buildGroup(def, registry);
    panelEl.appendChild(section); // 追加到 .panel-head 之后
    if (def.dynamic) {
      dynamicGroups.push({ def, section, entries: registry });
    } else {
      for (const entry of registry) staticEntries.push(entry);
    }
  }

  const collapseBtn = document.getElementById('btn-collapse');
  if (collapseBtn && !collapseBtn.dataset.bound) {
    collapseBtn.dataset.bound = '1';
    collapseBtn.addEventListener('click', togglePanelCollapsed);
  }

  syncUI(); // 所有控件生成后先按 state 回填一次
}

/** 从 state 全量刷新所有控件（拾取 / 键盘 / 预设后调用；未 init 时安全返回） */
export function syncUI() {
  if (!panelEl) return;

  // 先恢复动态组整体禁用态，再逐个回填（回填时按 path 精确禁用）
  for (const group of dynamicGroups) applyDynamicState(group.def, group.section);
  for (const entry of staticEntries) syncEntry(entry);
  for (const group of dynamicGroups) {
    for (const entry of group.entries) syncEntry(entry);
  }
}

/** 重建所有 dynamic 分组（选中物体变化后调用；位置不变；未 init 时安全返回） */
export function refreshDynamicGroups() {
  if (!panelEl) return;

  for (const group of dynamicGroups) {
    const registry = [];
    const fresh = buildGroup(group.def, registry);
    if (group.section.parentNode) {
      group.section.parentNode.insertBefore(fresh, group.section.nextSibling);
      group.section.remove();
    } else {
      panelEl.appendChild(fresh);
    }
    group.section = fresh;
    group.entries = registry;
  }
  syncUI();
}

/**
 * 更新底部 HUD。逐 key 容错：main.js 每帧传
 * { fps, tris, selected, shading, shadow, gpu }，元素不存在就跳过，不抛错。
 */
export function setHud(obj) {
  if (!obj || typeof obj !== 'object') return;

  const write = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  if (obj.fps !== undefined) {
    const fps = typeof obj.fps === 'number' && Number.isFinite(obj.fps)
      ? `${Math.round(obj.fps)} FPS`
      : (obj.fps === null || obj.fps === '' ? '— FPS' : String(obj.fps));
    write('hud-fps', fps);
  }
  if (obj.tris !== undefined) {
    // main.js 传的是已格式化好的字符串（如 '12.3k 三角形 · 24 draw'）；也兼容传裸数字
    const tris = typeof obj.tris === 'number' && Number.isFinite(obj.tris)
      ? `${formatCount(obj.tris)} 三角形`
      : String(obj.tris);
    write('hud-tris', tris);
  }
  if (obj.selected !== undefined) {
    // main.js 传选中物体名（如 '板条箱'）或已是说明文字的 '未选中（单击物体选中）'
    const selected = obj.selected ? String(obj.selected) : '—';
    write('hud-selected', selected.startsWith('未选中') ? selected : `选中：${selected}`);
  }
  if (obj.shading !== undefined) write('hud-shading', `着色：${obj.shading || '—'}`);
  if (obj.shadow !== undefined) write('hud-shadow', `阴影：${obj.shadow || '—'}`);
  if (obj.gpu !== undefined) write('hud-gpu', obj.gpu ? String(obj.gpu) : '—');
}

/** 显示短暂提示（#toast），ms 毫秒后自动移除 .show */
export function showToast(text, ms = 1800) {
  const el = document.getElementById('toast');
  if (!el) return;

  el.textContent = text === undefined || text === null ? '' : String(text);
  el.classList.add('show');

  if (toastTimer) clearTimeout(toastTimer);
  const delay = Math.max(300, Number(ms) || 1800);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    toastTimer = 0;
  }, delay);
}

/** 折叠 / 展开整个面板：只切 body 的 class，具体样式由 css/style.css 负责 */
export function togglePanelCollapsed() {
  const collapsed = document.body.classList.toggle('panel-collapsed');
  const btn = document.getElementById('btn-collapse');
  if (btn) {
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.title = collapsed ? '展开面板' : '收起面板';
  }
  return collapsed;
}

/**
 * tools/smoke.mjs —— 功能自测（无头浏览器 + CDP）
 * ------------------------------------------------------------------
 * 不只看"能不能出图"，而是逐项验证 AP3 的评分点真的在工作：
 *   1  页面/渲染器就绪、无报错、三角形数 > 0
 *   2  面板控件数量、HUD 文本、三分量开关 DOM 存在
 *   3  方向光阴影贴图：开/关两帧必须有可见差异
 *   4  点光源立方体阴影（E2）：开/关两帧必须有可见差异
 *   5  阴影贴图分辨率变化会改变画面（FBO 重建生效）
 *   6  颜色编码拾取：网格点击能命中 ≥4 个不同物体，且包含板条箱
 *   7  法线贴图（E1）：开/关特写画面必须有明显差异
 *   8  着色模型：Phong / Blinn-Phong / Toon 三帧两两不同
 *   9  透明混合（E2）：玻璃球不透明度 0.35 与 1.0 画面不同
 *  10  键盘快捷键：1/2/3、A、H、X、空格 都能改 state
 *  11  面板 DOM 点击：勾选框能改 state 且 syncUI 能回填
 *  12  截图 API 返回 PNG dataURL
 *
 * 用法：node tools/smoke.mjs        （需要非受限环境，浏览器子进程要用命名管道）
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8135;
const CDP_PORT = 9378;

/* ---------------------------- 静态服务器 ---------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};
function startServer() {
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.normalize(path.join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404).end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/* ---------------------------- CDP 客户端 ---------------------------- */
class CDP {
  constructor(ws) {
    this.ws = ws; this.nextId = 1; this.pending = new Map(); this.listeners = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`无法连接 CDP：${url}`)); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时：${method}`)); } }, 120000);
    });
  }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
];
const findBrowser = () => CANDIDATES.find((p) => fs.existsSync(p));

async function waitForCdp(port, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('CDP 端口未就绪');
}

/* ---------------------------- 页面求值 ---------------------------- */
async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (result.exceptionDetails) {
    throw new Error(`页面求值异常：${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
  }
  return result.result ? result.result.value : undefined;
}

const SETTLE = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80))))`;
async function settle(cdp, extra = 0) {
  await evaluate(cdp, SETTLE, true);
  if (extra) await new Promise((r) => setTimeout(r, extra));
}

/** 把画布缩略成 96×60 的 RGBA 数组（用于两帧像素对比） */
const GRAB_JS = `(() => {
  const c = document.getElementById('gl-canvas');
  const t = document.createElement('canvas');
  t.width = 96; t.height = 60;
  const ctx = t.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(c, 0, 0, 96, 60);
  return Array.from(ctx.getImageData(0, 0, 96, 60).data);
})()`;

async function grab(cdp) { return evaluate(cdp, GRAB_JS); }

function diff(a, b) {
  let sum = 0, max = 0, changed = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 3; k++) d += Math.abs(a[i + k] - b[i + k]);
    d /= 3;
    sum += d; if (d > max) max = d; if (d > 2) changed += 1; n += 1;
  }
  return { mean: sum / n, max, changedRatio: changed / n };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
}

/* ================================================================== */
/*  检查项                                                            */
/* ================================================================== */
async function run() {
  const server = await startServer();
  const browser = findBrowser();
  if (!browser) throw new Error('未找到 Edge / Chrome');
  const userDataDir = path.join(os.tmpdir(), 'ap3-smoke-profile');
  await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  const child = spawn(browser, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter',
    '--disable-features=Translate', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--force-device-scale-factor=1', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`, '--window-size=1600,1000', 'about:blank'
  ], { stdio: 'ignore' });

  const problems = [];
  let cdp = null;
  try {
    cdp = await CDP.connect(await waitForCdp(CDP_PORT));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?preset=overview` });

    // 等就绪
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if (await evaluate(cdp, '!!window.__AP3_READY__')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await settle(cdp, 300);

    cdp.on('Runtime.exceptionThrown', (p) => problems.push(`异常：${p.exceptionDetails?.text}`));

    /* ---------- 1. 就绪 ---------- */
    const ready = await evaluate(cdp, `JSON.stringify({
      ready: !!window.__AP3_READY__,
      tris: window.AP3.state.stats.tris,
      gpu: window.AP3.state.stats.gpu,
      errorShown: getComputedStyle(document.getElementById('error-box')).display !== 'none',
      canvasW: document.getElementById('gl-canvas').width,
      canvasH: document.getElementById('gl-canvas').height
    })`);
    const r1 = JSON.parse(ready);
    check('1. 页面就绪 / 场景三角形', r1.ready && r1.tris > 5000 && !r1.errorShown,
      `tris=${r1.tris}, canvas=${r1.canvasW}x${r1.canvasH}, GPU=${String(r1.gpu).slice(0, 60)}`);

    /* ---------- 2. 面板与 HUD ---------- */
    const ui = await evaluate(cdp, `JSON.stringify({
      groups: document.querySelectorAll('#panel .group').length,
      controls: document.querySelectorAll('#panel input, #panel select, #panel button').length,
      hud: ['hud-fps','hud-tris','hud-selected','hud-shading','hud-shadow','hud-gpu'].filter((id) => (document.getElementById(id)||{}).textContent),
      schemaCheck: !!document.getElementById('chk-ambient-on') && !!document.getElementById('rng-mat-shininess'),
      helpItems: document.querySelectorAll('#help li').length
    })`);
    const u = JSON.parse(ui);
    check('2. 面板由 schema 生成 / HUD 文本', u.groups >= 6 && u.controls >= 50 && u.hud.length === 6 && u.schemaCheck,
      `groups=${u.groups}, controls=${u.controls}, hud=${u.hud.length}/6, help=${u.helpItems} 条`);

    /* ---------- 3. 方向光阴影 ---------- */
    // 阴影在画面里只占物体投影那一小块（地面大部分受光），所以不能只看整幅平均差，
    // 而是用「阴影因子可视化」直接统计"处在阴影里的片元"比例。
    const darkRatio = (arr) => {
      let dark = 0, total = 0;
      for (let i = 0; i < arr.length; i += 4) { total += 1; if (arr[i] < 45) dark += 1; }
      return dark / total;
    };
    const base = `window.AP3.resetState(); window.AP3.applyPreset('shadow'); window.AP3.syncUI(); window.AP3.refreshDynamicGroups();`;
    await evaluate(cdp, base + ` window.AP3.state.display.debugMode = 1; window.AP3.state.shadow.enabled = true;`);
    await settle(cdp, 500); const shadowFactor = await grab(cdp);
    await evaluate(cdp, `window.AP3.state.shadow.enabled = true; window.AP3.state.display.debugMode = 0;`);
    await settle(cdp, 500); const withShadow = await grab(cdp);
    await evaluate(cdp, `window.AP3.state.shadow.enabled = false;`);
    await settle(cdp, 500); const noShadow = await grab(cdp);
    const dShadow = diff(withShadow, noShadow);
    const shadowDark = darkRatio(shadowFactor);
    check('3. 方向光阴影贴图生效',
      shadowDark > 0.01 && shadowDark < 0.9 && dShadow.max > 20,
      `阴影像素比例=${(shadowDark * 100).toFixed(1)}%（阴影因子图），开关阴影画面最大差=${dShadow.max.toFixed(0)}`);

    /* ---------- 4. 点光立方体阴影（E2） ---------- */
    // 同样用点阴影因子可视化统计，避免"整体变暗"这种无法区分正确性的指标
    await evaluate(cdp, `window.AP3.resetState(); window.AP3.applyPreset('extension-e2'); window.AP3.syncUI(); window.AP3.state.shadow.enabled = true; window.AP3.state.shadow.mode = 'point'; window.AP3.state.display.debugMode = 5;`);
    await settle(cdp, 900); const pointFactor = await grab(cdp);
    const pointDark = darkRatio(pointFactor);
    check('4. 点光源立方体阴影生效',
      pointDark > 0.01 && pointDark < 0.9,
      `点阴影像素比例=${(pointDark * 100).toFixed(1)}%（点阴影因子图）`);
    await evaluate(cdp, `window.AP3.state.display.debugMode = 0;`);
    await settle(cdp, 300);

    /* ---------- 5. 阴影分辨率变化 ---------- */
    await evaluate(cdp, `window.AP3.resetState(); window.AP3.applyPreset('shadow'); window.AP3.syncUI(); window.AP3.state.shadow.resolution = 1024;`);
    await settle(cdp, 600); const resLow = await grab(cdp);
    await evaluate(cdp, `window.AP3.state.shadow.resolution = 4096;`);
    await settle(cdp, 900); const resHigh = await grab(cdp);
    const dRes = diff(resLow, resHigh);
    check('5. 阴影贴图分辨率切换（FBO 重建）', dRes.mean > 0.05,
      `meanDiff=${dRes.mean.toFixed(3)}（锯齿差异，越大越明显）`);

    /* ---------- 6. 颜色编码拾取 ---------- */
    await evaluate(cdp, `window.AP3.resetState(); window.AP3.applyPreset('overview'); document.body.classList.add('ui-hidden'); window.AP3.syncUI();`);
    await settle(cdp, 400);
    const pick = await evaluate(cdp, `(() => {
      const p = window.AP3.renderer.pickAtCss;
      const hits = new Set();
      const names = new Set();
      for (let y = 120; y < 950; y += 60) {
        for (let x = 60; x < 1250; x += 60) {
          const item = p.call(window.AP3.renderer, x, y);
          if (item) { hits.add(item.id); names.add(item.name); }
        }
      }
      return JSON.stringify({ ids: [...hits], names: [...names] });
    })()`);
    const pickData = JSON.parse(pick);
    check('6. 颜色编码拾取命中多个物体', pickData.ids.length >= 4 && pickData.ids.includes('crate'),
      `命中 ${pickData.ids.length} 个：${pickData.ids.slice(0, 8).join(', ')}`);

    /* ---------- 7. 法线贴图（E1） ---------- */
    const crateCam = `window.AP3.resetState(); window.AP3.state.camera.azimuth = 0.55; window.AP3.state.camera.elevation = 0.20; window.AP3.state.camera.distance = 3.1; window.AP3.state.camera.target = [1.85, 0.75, -0.9]; window.AP3.state.camera.autoRotate = false; window.AP3.state.display.paused = true; window.AP3.state.shadow.enabled = false; window.AP3.syncUI();`;
    await evaluate(cdp, crateCam + ` window.AP3.state.textures.normalMap = true; window.AP3.state.textures.normalStrength = 2.0;`);
    await settle(cdp, 500); const withNormal = await grab(cdp);
    await evaluate(cdp, `window.AP3.state.textures.normalMap = false;`);
    await settle(cdp, 500); const withoutNormal = await grab(cdp);
    const dNormal = diff(withNormal, withoutNormal);
    check('7. 法线贴图对比（E1）', dNormal.mean > 0.8 && dNormal.changedRatio > 0.03,
      `meanDiff=${dNormal.mean.toFixed(2)}, changed=${(dNormal.changedRatio * 100).toFixed(1)}%`);

    /* ---------- 8. 三种着色模型两两不同 ---------- */
    const shadingState = `window.AP3.resetState(); window.AP3.applyPreset('extension-e3'); window.AP3.state.compare.split = false; document.body.classList.remove('ui-hidden'); window.AP3.state.camera.distance = 4.2; window.AP3.state.camera.target = [0.15, 0.6, 1.15]; window.AP3.syncUI();`;
    const shades = {};
    for (const mode of ['phong', 'blinn', 'toon']) {
      await evaluate(cdp, shadingState + ` window.AP3.state.shading = '${mode}'; window.AP3.syncUI();`);
      await settle(cdp, 500);
      shades[mode] = await grab(cdp);
    }
    const dPB = diff(shades.phong, shades.blinn);
    const dPT = diff(shades.phong, shades.toon);
    const dBT = diff(shades.blinn, shades.toon);
    check('8. Phong / Blinn-Phong / Toon 三者不同',
      dPB.max > 12 && dPT.mean > 1.0 && dBT.mean > 1.0,
      `Phong↔Blinn max=${dPB.max.toFixed(1)}, Phong↔Toon mean=${dPT.mean.toFixed(2)}, Blinn↔Toon mean=${dBT.mean.toFixed(2)}`);

    /* ---------- 9. 透明混合（E2） ---------- */
    const glassCam = `window.AP3.resetState(); window.AP3.state.camera.azimuth = 0.42; window.AP3.state.camera.elevation = 0.22; window.AP3.state.camera.distance = 3.0; window.AP3.state.camera.target = [-1.15, 0.5, 1.85]; window.AP3.state.camera.autoRotate = false; window.AP3.state.display.paused = true; window.AP3.state.shadow.enabled = false; window.AP3.syncUI();`;
    await evaluate(cdp, glassCam + ` window.AP3.state.materials.glassSphere.opacity = 0.25;`);
    await settle(cdp, 500); const glassOn = await grab(cdp);
    await evaluate(cdp, `window.AP3.state.materials.glassSphere.opacity = 1.0;`);
    await settle(cdp, 500); const glassOff = await grab(cdp);
    const dGlass = diff(glassOn, glassOff);
    check('9. 透明混合（blend）生效', dGlass.mean > 1.0,
      `meanDiff=${dGlass.mean.toFixed(2)}`);

    /* ---------- 10. 键盘快捷键 ---------- */
    const keys = await evaluate(cdp, `(() => {
      const s = window.AP3.state;
      const out = {};
      const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      s.shading = 'phong'; press('2'); out.k2 = s.shading;
      press('3'); out.k3 = s.shading;
      const beforeA = s.phong.ambient; press('a'); out.kA = s.phong.ambient !== beforeA;
      const beforeH = s.shadow.enabled; press('h'); out.kH = s.shadow.enabled !== beforeH;
      press('x'); out.kX = s.compare.split;
      const beforeSpace = s.display.paused; press(' '); out.kSpace = s.display.paused !== beforeSpace;
      press('o'); out.kO = s.camera.projection;
      window.AP3.state.compare.split = false;
      return JSON.stringify(out);
    })()`);
    const k = JSON.parse(keys);
    check('10. 键盘快捷键（1/2/3、A、H、X、空格、O）',
      k.k2 === 'blinn' && k.k3 === 'toon' && k.kA && k.kH && k.kX === true && k.kSpace && k.kO === 'orthographic',
      JSON.stringify(k));

    /* ---------- 11. 面板 DOM 点击联动 ---------- */
    const dom = await evaluate(cdp, `(() => {
      const s = window.AP3.state;
      window.AP3.resetState(); window.AP3.syncUI();
      const cb = document.getElementById('chk-ambient-on');
      const before = s.phong.ambient;
      cb.click();
      const after = s.phong.ambient;
      const slider = document.getElementById('rng-mat-shininess');
      return JSON.stringify({ before, after, toggled: before !== after, sliderExists: !!slider });
    })()`);
    const domData = JSON.parse(dom);
    check('11. 面板控件点击写入 state', domData.toggled && domData.sliderExists, JSON.stringify(domData));

    /* ---------- 12. 截图 API ---------- */
    const shot = await evaluate(cdp, `window.AP3.renderer.screenshot().startsWith('data:image/png;base64,')`);
    check('12. 截图 API 返回 PNG dataURL', shot === true, String(shot));
  } finally {
    if (cdp) cdp.close();
    child.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log('');
  const failed = results.filter((r) => !r.ok);
  console.log(`共 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(` - ${f.name}：${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('SMOKE ALL PASSED');
  }
  if (problems.length) {
    console.log('页面异常：');
    for (const p of problems) console.log(` - ${p}`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('功能自测失败：', err.message);
  process.exitCode = 1;
});

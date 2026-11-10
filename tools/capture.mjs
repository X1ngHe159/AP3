/**
 * tools/capture.mjs —— 用 Edge/Chrome 的 DevTools 协议做无头 WebGL 截图 + 冒烟验证
 * ------------------------------------------------------------------
 * 用途：
 *   1) 生成 README 所需的全部截图（docs/screenshots/*.png）；
 *   2) 冒烟测试：确认页面能启动、渲染器就绪、画面不是纯黑/纯色、无 JS 报错。
 *
 * 用法：
 *   node tools/capture.mjs             # 全部截图 + 冒烟检查
 *   node tools/capture.mjs --smoke     # 只做冒烟检查（不写截图，速度快）
 *   node tools/capture.mjs --only=01-overview,13-shading-split   # 只截部分
 *
 * 注意：浏览器子进程需要命名管道通信，必须在**非受限**环境下运行（本课程环境里用完全权限跑一次即可）。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots');
const PORT = 8134;
const CDP_PORT = 9377;
const VIEW = { width: 1600, height: 1000 };

/* ------------------------------------------------------------------ */
/*  1. 静态服务器                                                       */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function startServer() {
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.normalize(path.join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404).end('404'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------------------ */
/*  2. 极简 CDP 客户端（Node 内置 WebSocket）                            */
/* ------------------------------------------------------------------ */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        const list = this.listeners.get(msg.method) || [];
        for (const fn of list) fn(msg.params);
      }
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`无法连接 CDP：${url}`));
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 120000);
    });
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/* ------------------------------------------------------------------ */
/*  3. 启动浏览器                                                       */
/* ------------------------------------------------------------------ */
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

function findBrowser() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Edge / Chrome，请手动修改 CANDIDATES');
}

async function waitForCdp(port, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('CDP 端口未就绪');
}

/* ------------------------------------------------------------------ */
/*  4. 页面辅助                                                         */
/* ------------------------------------------------------------------ */
async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise
  });
  if (result.exceptionDetails) {
    throw new Error(`页面求值异常：${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception?.description || '')}`);
  }
  return result.result ? result.result.value : undefined;
}

async function pollReady(cdp, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const view = await evaluate(cdp, 'JSON.stringify({ready: !!window.__AP3_READY__, err: (document.getElementById("error-text")||{}).textContent || null, errShown: !!document.getElementById("error-box") && getComputedStyle(document.getElementById("error-box")).display !== "none"})');
    const parsed = JSON.parse(view || '{}');
    if (parsed.errShown) throw new Error(`页面错误框：${parsed.err}`);
    if (parsed.ready) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('页面未在超时时间内就绪');
}

/** 等两帧 + 一点余量，确保状态改动已经被渲染出来 */
const SETTLE = `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60))))`;

async function settle(cdp, extraMs = 0) {
  await evaluate(cdp, SETTLE, true);
  if (extraMs) await new Promise((r) => setTimeout(r, extraMs));
}

/** 采样画布像素统计：用来判断"画面不是纯黑 / 纯色" */
const PIXEL_PROBE = `(() => {
  const c = document.getElementById('gl-canvas');
  if (!c) return { error: 'no canvas' };
  const t = document.createElement('canvas');
  t.width = 160; t.height = 100;
  const ctx = t.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(c, 0, 0, 160, 100);
  const d = ctx.getImageData(0, 0, 160, 100).data;
  let sum = [0, 0, 0], min = [255, 255, 255], max = [0, 0, 0];
  const colors = new Set();
  for (let i = 0; i < d.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      sum[k] += d[i + k];
      if (d[i + k] < min[k]) min[k] = d[i + k];
      if (d[i + k] > max[k]) max[k] = d[i + k];
    }
    colors.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
  }
  const n = d.length / 4;
  return {
    mean: sum.map((v) => +(v / n).toFixed(1)),
    min, max,
    distinct: colors.size,
    glError: (() => { try { return window.AP3 && window.AP3.renderer ? 0 : 0; } catch (e) { return -1; } })()
  };
})()`;

async function screenshot(cdp, filePath) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true
  });
  await fsp.writeFile(filePath, Buffer.from(data, 'base64'));
  return filePath;
}

/* ------------------------------------------------------------------ */
/*  5. 截图清单                                                        */
/* ------------------------------------------------------------------ */
const SHOTS = [
  { name: '01-overview', preset: 'overview', ui: true, desc: '庭院总览（面板 + Phong + 纹理 + 阴影）' },
  { name: '02-combo-ambient', preset: 'combo-ambient', ui: false, desc: '只开环境光分量' },
  { name: '03-combo-diffuse', preset: 'combo-diffuse', ui: false, desc: '只开漫反射分量' },
  { name: '04-combo-specular', preset: 'combo-specular', ui: false, desc: '只开镜面分量' },
  { name: '05-combo-all', preset: 'combo-all', ui: false, desc: '三分量全开' },
  { name: '06-shadow', preset: 'shadow', ui: false, desc: '方向光阴影贴图（2048² + 3×3 PCF）' },
  { name: '07-shadow-acne', preset: 'shadow-debug', ui: false, desc: 'bias=0 + 显示深度图：阴影粉刺（调参对比）' },
  { name: '08-uv-dataflow', preset: 'uv-dataflow', ui: false, desc: 'UV 棋盘方块：顶点 UV → 纹理采样' },
  { name: '09-reflection', preset: 'reflection', ui: false, desc: '反射球 + 立方体环境贴图' },
  { name: '10-picking', preset: 'picking', ui: true, desc: '拾取板条箱：高亮描边 + 面板切换到该物体材质' },
  { name: '11-normal-split', preset: 'extension-e1', ui: false, desc: 'E1 法线贴图对比（左：平滑法线 / 右：法线贴图）' },
  { name: '12-transparency', preset: 'extension-e2', ui: true, desc: 'E2 透明玻璃球混合 + 点光立方体阴影' },
  { name: '13-shading-split', preset: 'extension-e3', ui: false, desc: 'E3 三联对比：Phong / Blinn–Phong / Toon' },
  { name: '14-wireframe', preset: 'wireframe', ui: false, desc: '线框模式（几何体拓扑）' },
  { name: '15-light-helpers', preset: 'light-helpers', ui: false, desc: '光源辅助显示（方向光 + 2 点光）' },
  { name: '16-orthographic', preset: 'overview', ui: false, desc: '正交投影（对比透视）', post: `window.AP3.state.camera.projection = 'orthographic'; window.AP3.syncUI();` },
  { name: '17-shadow-map-window', preset: 'shadow', ui: true, desc: '阴影深度图小窗（面板可调 bias / 正交范围）', post: `window.AP3.state.shadow.showMap = true; window.AP3.syncUI();` },
  { name: '18-panel-material', preset: 'picking', ui: true, desc: '参数面板：选中物体的材质参数联动', post: `window.AP3.selectById('mirrorSphere');` },
  { name: '19-shadow-factor', preset: 'shadow', ui: false, desc: '阴影因子可视化（白=受光 / 黑=阴影），说明两遍渲染第二遍的深度比较结果', post: `window.AP3.state.display.debugMode = 1; window.AP3.state.shadow.enabled = true;` },
  { name: '20-point-shadow-factor', preset: 'extension-e2', ui: false, desc: '点光源立方体阴影因子可视化（E2）', post: `window.AP3.state.shadow.enabled = true; window.AP3.state.shadow.mode = 'point'; window.AP3.state.display.debugMode = 5;` }
];

/* ------------------------------------------------------------------ */
/*  6. 主流程                                                          */
/* ------------------------------------------------------------------ */
async function main() {
  const args = process.argv.slice(2);
  const smokeOnly = args.includes('--smoke');
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const onlyNames = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;

  const server = await startServer();
  console.log(`静态服务器：http://127.0.0.1:${PORT}/`);

  const browser = findBrowser();
  const userDataDir = path.join(os.tmpdir(), 'ap3-capture-profile');
  await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});

  console.log(`启动浏览器：${browser}`);
  const child = spawn(browser, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-features=Translate',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--force-device-scale-factor=1',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${VIEW.width},${VIEW.height}`,
    'about:blank'
  ], { stdio: 'ignore' });

  const problems = [];
  let cdp = null;
  try {
    const wsUrl = await waitForCdp(CDP_PORT);
    cdp = await CDP.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false
    });

    // 控制台 / 异常收集
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        problems.push(`console.error: ${text}`);
      }
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      problems.push(`未捕获异常: ${p.exceptionDetails?.text} ${p.exceptionDetails?.exception?.description || ''}`);
    });
    cdp.on('Log.entryAdded', (p) => {
      if (p.entry.level === 'error') problems.push(`日志错误: ${p.entry.text}`);
    });

    console.log('打开页面…');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?preset=overview` });
    await pollReady(cdp);
    await settle(cdp, 400);

    const gpu = await evaluate(cdp, '(window.AP3 && window.AP3.state.stats.gpu) || "—"');
    const tris = await evaluate(cdp, '(window.AP3 && window.AP3.state.stats.tris) || 0');
    console.log(`渲染器就绪：GPU = ${gpu}；场景三角形 = ${tris}`);
    if (!tris) problems.push('场景三角形数为 0（几何体可能没创建成功）');

    if (smokeOnly) {
      // 冒烟：几个关键预设各渲一帧，检查画面非纯色
      for (const preset of ['overview', 'combo-all', 'shadow', 'extension-e3', 'extension-e2', 'picking']) {
        await evaluate(cdp, `window.AP3.resetState(); window.AP3.applyPreset('${preset}'); window.AP3.syncUI(); window.AP3.refreshDynamicGroups(); window.AP3.updateCompareLabels();`);
        await settle(cdp, 500);
        const stats = await evaluate(cdp, PIXEL_PROBE);
        console.log(`  ${preset.padEnd(14)} mean=${JSON.stringify(stats.mean)} distinct=${stats.distinct} max=${JSON.stringify(stats.max)}`);
        if (stats.distinct < 12) problems.push(`预设 ${preset} 画面色彩种类过少（${stats.distinct}），可能渲染异常`);
        if (stats.max[0] < 12 && stats.max[1] < 12 && stats.max[2] < 12) problems.push(`预设 ${preset} 画面接近全黑`);
      }
    } else {
      await fsp.mkdir(SHOT_DIR, { recursive: true });
      const shots = onlyNames ? SHOTS.filter((s) => onlyNames.includes(s.name)) : SHOTS;
      for (const shot of shots) {
        process.stdout.write(`  截图 ${shot.name} ... `);
        try {
          await evaluate(cdp, `
            window.AP3.resetState();
            window.AP3.applyPreset('${shot.preset}');
            document.body.classList.toggle('ui-hidden', ${shot.ui ? 'false' : 'true'});
            ${shot.post || ''}
            window.AP3.syncUI();
            window.AP3.refreshDynamicGroups();
            window.AP3.updateCompareLabels();
          `);
          await settle(cdp, shot.preset.startsWith('shadow') ? 900 : 400);
          const stats = await evaluate(cdp, PIXEL_PROBE);
          if (stats.distinct < 12) problems.push(`截图 ${shot.name} 画面色彩过少（distinct=${stats.distinct}）`);
          await screenshot(cdp, path.join(SHOT_DIR, `${shot.name}.png`));
          console.log(`ok  mean=${JSON.stringify(stats.mean)} distinct=${stats.distinct}`);
        } catch (err) {
          // 单张失败不影响其余截图，最后统一汇总
          problems.push(`截图 ${shot.name} 失败：${err.message}`);
          console.log(`失败：${err.message}`);
        }
      }
      console.log(`共 ${shots.length} 张截图 → ${SHOT_DIR}`);
    }

    // 最终统计
    const finalStats = await evaluate(cdp, PIXEL_PROBE);
    console.log(`最终像素统计：mean=${JSON.stringify(finalStats.mean)} distinct=${finalStats.distinct}`);
  } finally {
    if (cdp) {
      try {
        const errs = await evaluate(cdp, 'JSON.stringify((window.AP3 && window.AP3.state.stats) || {})');
        console.log(`客户端统计：${errs}`);
      } catch { /* ignore */ }
      cdp.close();
    }
    child.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 400));
  }

  if (problems.length) {
    console.error(`\n发现 ${problems.length} 个问题：`);
    for (const p of problems) console.error(` - ${p}`);
    process.exitCode = 1;
  } else {
    console.log('\n全部通过，未发现页面错误。');
  }
}

main().catch((err) => {
  console.error('\n截图流程失败：', err.message);
  process.exitCode = 1;
});

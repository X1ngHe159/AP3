/**
 * tools/verify-pages.mjs —— 线上部署验证
 * ------------------------------------------------------------------
 * 用无头 Edge 打开 GitHub Pages 上的公网地址，检查：
 *   1) 页面是否成功初始化（window.__AP3_READY__）
 *   2) 控制台是否有 error / WebGL 警告
 *   3) 是否有资源请求失败（4xx/5xx / 网络错误）
 *   4) 渲染是否真的出画（canvas 非纯色 + 三角形数 / draw call）
 * 并保存一张线上截图 docs/screenshots/25-deployed-pages.png。
 *
 * 用法：node tools/verify-pages.mjs [url]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const URL_ = process.argv[2] || 'https://x1nghe159.github.io/AP3/';
const CDP_PORT = 9391;

class CDP {
  constructor(ws) {
    this.ws = ws; this.nextId = 1; this.pending = new Map(); this.listeners = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('无法连接 CDP')); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时：${method}`)); } }, 60000);
    });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

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

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    throw new Error(`${d.text} ${d.exception ? d.exception.description || d.exception.value : ''}`.trim());
  }
  return result.result ? result.result.value : undefined;
}

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
];

async function main() {
  const browser = CANDIDATES.find((p) => fs.existsSync(p));
  if (!browser) throw new Error('未找到 Edge/Chrome');
  const userDataDir = path.join(os.tmpdir(), 'ap3-verify-pages-profile');
  await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  const child = spawn(browser, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--force-device-scale-factor=1',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    '--window-size=1600,1000', 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  const consoleErrors = [];
  const failedRequests = [];
  const badResponses = [];

  try {
    cdp = await CDP.connect(await waitForCdp(CDP_PORT));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');

    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
        consoleErrors.push(`[${msg.params.type}] ${text}`);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        consoleErrors.push(`[log] ${msg.params.entry.text} ${msg.params.entry.url || ''}`.trim());
      }
      if (msg.method === 'Network.loadingFailed' && !msg.params.canceled) {
        failedRequests.push(`${msg.params.errorText} ${msg.params.type}`);
      }
      if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
        badResponses.push(`${msg.params.response.status} ${msg.params.response.url}`);
      }
    });

    await cdp.send('Page.navigate', { url: URL_ });

    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 90000) {
      try { ready = await evaluate(cdp, '!!window.__AP3_READY__'); } catch { /* 导航中 */ }
      if (ready) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    await evaluate(cdp, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 800))))', true);

    const info = await evaluate(cdp, `(() => {
      try {
        const c = document.querySelector('canvas');
        if (!c) return { ok: false, reason: 'no canvas' };
        const gl = window.AP3 && window.AP3.gl;
        const errs = [];
        if (gl) { let e; while ((e = gl.getError()) !== gl.NO_ERROR) errs.push(e); }
        const pixels = new Uint8Array(4 * 64 * 64);
        if (gl) gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const uniq = new Set();
        for (let i = 0; i < pixels.length; i += 4) uniq.add(pixels[i] + ',' + pixels[i+1] + ',' + pixels[i+2]);
        return {
          ok: true,
          title: document.title,
          canvas: [c.width, c.height],
          gpu: gl && gl.getParameter(gl.RENDERER),
          glErrors: errs,
          tris: document.getElementById('hud-tris') && document.getElementById('hud-tris').textContent,
          objects: window.AP3 && window.AP3.state && window.AP3.state.scene ? window.AP3.state.scene.objects.length : null,
          distinctColorsInCorner: uniq.size,
          stats: window.AP3 && window.AP3.renderer ? window.AP3.renderer.stats : null
        };
      } catch (e) { return { ok: false, error: String(e) }; }
    })()`, true);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const outPath = path.join(ROOT, 'docs', 'screenshots', '25-deployed-pages.png');
    await fs.promises.writeFile(outPath, Buffer.from(shot.data, 'base64'));

    const report = {
      url: URL_,
      ready,
      info,
      consoleErrors: consoleErrors.slice(0, 12),
      failedRequests: [...new Set(failedRequests)].slice(0, 12),
      badResponses: [...new Set(badResponses)].slice(0, 12),
      screenshot: path.relative(ROOT, outPath),
      verdict: ready && consoleErrors.length === 0 && badResponses.length === 0 && failedRequests.length === 0 && info && info.ok && info.distinctColorsInCorner > 1 ? 'PASS' : 'FAIL'
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (cdp) cdp.close();
    child.kill();
  }
}

main().catch((err) => {
  console.error('线上验证失败：', err.message);
  process.exitCode = 1;
});

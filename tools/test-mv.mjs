/**
 * tools/test-mv.mjs —— lib/MV.js 的 Node 单元测试（零第三方依赖，node 直接运行）。
 *
 * 运行：node tools/test-mv.mjs
 *
 * lib/ 下的三个文件是“经典脚本”（IIFE，挂 window 全局），因此这里不能用 import 加载。
 * 做法：
 *   1) 用 node:fs 读取源码；
 *   2) 用 node:vm 建一个沙箱，把沙箱的 window 指向它自己（与浏览器行为一致）；
 *   3) 在沙箱里依次执行三个脚本，再从沙箱取 window.MV；
 *   4) 对 MV 的每个矩阵 / 向量函数做数值断言（容差 1e-6）。
 *
 * 另外附带对 initShaders / WebGLUtils 的 mock 冒烟测试，保证三个经典脚本在 Node 里
 * 都能正常执行、只挂载约定好的三个全局名。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TOLERANCE = 1e-6;

/* =========================================================================
 * 微型测试框架
 * ========================================================================= */

let passed = 0;
const failures = [];

function pass(name) {
  passed++;
  console.log('  \u2713 ' + name);
}

function fail(name, expected, actual) {
  failures.push(name);
  console.error('  \u2717 ' + name);
  console.error('      期望: ' + format(expected));
  console.error('      实际: ' + format(actual));
}

function format(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value.length === 'number' && typeof value !== 'string') {
    return '[' + Array.from(value).map((v) => {
      return typeof v === 'number' ? Number(v.toFixed(10)) : String(v);
    }).join(', ') + ']';
  }
  return String(value);
}

function check(name, condition, expected, actual) {
  if (condition) {
    pass(name);
  } else {
    fail(name, expected, actual);
  }
}

function expectArray(name, actual, expected, tolerance = TOLERANCE) {
  let ok = actual !== null && actual !== undefined &&
           typeof actual.length === 'number' &&
           actual.length === expected.length;
  if (ok) {
    for (let i = 0; i < expected.length; i++) {
      if (!Number.isFinite(actual[i]) || Math.abs(actual[i] - expected[i]) > tolerance) {
        ok = false;
        break;
      }
    }
  }
  if (ok) pass(name);
  else fail(name, expected, actual);
}

function expectScalar(name, actual, expected, tolerance = TOLERANCE) {
  if (Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance) {
    pass(name);
  } else {
    fail(name, expected, actual);
  }
}

function expectThrows(name, fn, patterns) {
  let caught = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const text = caught && caught.message ? caught.message : String(caught);
  if (caught && list.every((p) => text.includes(p))) {
    pass(name);
  } else {
    fail(name, '抛出包含 ' + list.map((p) => JSON.stringify(p)).join(' 且 ') + ' 的 Error',
         caught ? text : '没有抛错');
  }
}

/* =========================================================================
 * 一、在 vm 沙箱中加载经典脚本
 * ========================================================================= */

const scriptElements = {
  'test-vs': {
    textContent: '#version 300 es\nin vec3 aPosition;\nvoid main() {\n  gl_Position = vec4(aPosition, 1.0);\n}\n'
  },
  'test-fs': {
    textContent: '#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main() {\n  fragColor = vec4(1.0);\n}\n'
  }
};
const canvasElements = {};

const documentMock = {
  getElementById(id) {
    return scriptElements[id] || canvasElements[id] || null;
  }
};

const sandbox = {
  console,
  document: documentMock
};
// 让沙箱里的 window 指向沙箱自身；globalThis 也放进去（与浏览器环境尽量一致）。
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

try {
  vm.createContext(sandbox);
  const files = ['lib/MV.js', 'lib/initShaders.js', 'lib/webgl-utils.js'];
  for (const file of files) {
    const code = readFileSync(join(ROOT, file), 'utf8');
    // 用 runInContext 执行经典脚本：若文件里误用了 import/export，这里会直接语法错误。
    vm.runInContext(code, sandbox, { filename: file });
  }
} catch (e) {
  console.error('加载 lib/ 经典脚本失败：');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}

const MV = sandbox.MV;
const initShaders = sandbox.initShaders;
const WebGLUtils = sandbox.WebGLUtils;

console.log('== 0. 经典脚本加载与命名空间 ==');

check('window.MV 已挂载', !!(MV && typeof MV === 'object'), 'MV 对象', MV);
check('window.MV.mat4 / MV.mult / MV.lookAt 可用',
      typeof MV.mat4 === 'function' && typeof MV.mult === 'function' && typeof MV.lookAt === 'function',
      '三个函数', MV && [typeof MV.mat4, typeof MV.mult, typeof MV.lookAt]);
check('window.initShaders.createShader / createProgram 可用',
      !!(initShaders && typeof initShaders.createShader === 'function' &&
         typeof initShaders.createProgram === 'function'),
      '两个函数', initShaders && Object.keys(initShaders));
check('window.WebGLUtils.setupWebGL / resizeCanvasToDisplaySize / getContext 可用',
      !!(WebGLUtils && typeof WebGLUtils.setupWebGL === 'function' &&
         typeof WebGLUtils.resizeCanvasToDisplaySize === 'function' &&
         typeof WebGLUtils.getContext === 'function'),
      '三个函数', WebGLUtils && Object.keys(WebGLUtils));

const allowedGlobals = ['console', 'document', 'window', 'globalThis', 'self',
                        'MV', 'initShaders', 'WebGLUtils'];
const leakedGlobals = Object.keys(sandbox).filter((k) => !allowedGlobals.includes(k));
check('经典脚本没有污染其它全局名', leakedGlobals.length === 0,
      '无额外全局名', leakedGlobals);

/* =========================================================================
 * 二、测试用的小工具
 * ========================================================================= */

/** 4x4 矩阵（列主序）乘四维列向量。 */
function apply4(m, p) {
  const x = p[0], y = p[1], z = p[2], w = p[3];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w
  ];
}

/** 4x4 矩阵变换“点”（w = 1），返回齐次坐标。 */
function applyPoint(m, p) {
  return apply4(m, [p[0], p[1], p[2], 1]);
}

/** 4x4 矩阵变换点后做透视除法，得到 NDC 坐标。 */
function project(m, p) {
  const clip = applyPoint(m, p);
  const w = clip[3];
  return [clip[0] / w, clip[1] / w, clip[2] / w];
}

/** 3x3 矩阵（列主序）乘三维向量。 */
function apply3(m, v) {
  const x = v[0], y = v[1], z = v[2];
  return [
    m[0] * x + m[3] * y + m[6] * z,
    m[1] * x + m[4] * y + m[7] * z,
    m[2] * x + m[5] * y + m[8] * z
  ];
}

/** 从 4x4 模型中取出左上 3x3（列主序长度 9）。 */
function upper3(m) {
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
}

function norm3(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

/* =========================================================================
 * 三、基础构造与 mult 顺序
 * ========================================================================= */

console.log('\n== 1. mat4 / mat3 / vec / mult 顺序 ==');

expectArray('mat4() 是 4x4 单位矩阵',
            MV.mat4(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

expectArray('mat3() 是 3x3 单位矩阵',
            MV.mat3(), [1, 0, 0, 0, 1, 0, 0, 0, 1]);

expectArray('vec3(1,2,3) -> [1,2,3]', MV.vec3(1, 2, 3), [1, 2, 3]);
expectArray('vec4(1,2,3,1) -> [1,2,3,1]', MV.vec4(1, 2, 3, 1), [1, 2, 3, 1]);

// A = 平移(1,2,3)，B = 绕 z 轴 90°；A*B 表示“先旋转、再平移”。
const A = MV.translate(1, 2, 3);
const B = MV.rotate(90, [0, 0, 1]);
const AB = MV.mult(A, B);
expectArray('mult(A,B) 作用于 (1,0,0)：先 rotate 后 translate -> (1,3,3)',
            project(AB, [1, 0, 0]), [1, 3, 3]);

// mult 返回新数组，且不修改入参
const ABackup = Array.from(A);
const BBackup = Array.from(B);
MV.mult(A, B);
expectArray('mult 不修改入参 A', A, ABackup);
expectArray('mult 不修改入参 B', B, BBackup);

/* =========================================================================
 * 四、rotate
 * ========================================================================= */

console.log('\n== 2. rotate ==');

expectArray('rotate(90,[0,0,1]) 作用于 (1,0,0) -> (0,1,0)',
            project(MV.rotate(90, [0, 0, 1]), [1, 0, 0]), [0, 1, 0]);

// 轴不需要预先归一化：长度 5 的轴与单位轴结果一致
expectArray('rotate 内部归一化轴：轴 (0,0,5) 与 (0,0,1) 等价',
            MV.rotate(90, [0, 0, 5]), MV.rotate(90, [0, 0, 1]));

// rotate(m, angle, axis) 等价于 mult(m, rotate(angle, axis))
const preRotate = MV.translate(4, -2, 7);
expectArray('rotate(m, angle, axis) == mult(m, rotate(angle, axis))',
            MV.rotate(preRotate, 37, [1, 2, 3]),
            MV.mult(preRotate, MV.rotate(37, [1, 2, 3])));

/* =========================================================================
 * 五、perspective
 * ========================================================================= */

console.log('\n== 3. perspective ==');

const P = MV.perspective(90, 1, 1, 101);
const pNear = applyPoint(P, [0, 0, -1]);
const pFar = applyPoint(P, [0, 0, -101]);
expectScalar('perspective: 近平面点 (0,0,-1) 的裁剪 w = 1', pNear[3], 1);
expectScalar('perspective: 近平面点 (0,0,-1) 的 NDC z ≈ -1', pNear[2] / pNear[3], -1);
expectScalar('perspective: 远平面点 (0,0,-101) 的 NDC z ≈ +1', pFar[2] / pFar[3], 1);
expectScalar('perspective: 远平面点的裁剪 w = 101（w = -z_eye）', pFar[3], 101);

/* =========================================================================
 * 六、ortho
 * ========================================================================= */

console.log('\n== 4. ortho ==');

const O = MV.ortho(-1, 1, -1, 1, 1, 101);
const oPoint = applyPoint(O, [1, 1, 0]);
expectScalar('ortho: w 分量恒为 1（没有透视除法）', oPoint[3], 1);
expectArray('ortho: (1,1,0) 映射到 NDC x,y = (1,1)',
            [oPoint[0] / oPoint[3], oPoint[1] / oPoint[3]], [1, 1]);
expectScalar('ortho: 近平面点 (0,0,-1) 的 NDC z ≈ -1',
             project(O, [0, 0, -1])[2], -1);
expectScalar('ortho: 远平面点 (0,0,-101) 的 NDC z ≈ +1',
             project(O, [0, 0, -101])[2], 1);

/* =========================================================================
 * 七、lookAt
 * ========================================================================= */

console.log('\n== 5. lookAt ==');

const V = MV.lookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]);
expectArray('lookAt([0,0,5],origin,up) * (0,0,0,1) -> (0,0,-5,1)',
            applyPoint(V, [0, 0, 0]), [0, 0, -5, 1]);
expectArray('lookAt: eye 本身映射到视图空间原点', applyPoint(V, [0, 0, 5]), [0, 0, 0, 1]);

/* =========================================================================
 * 八、normalMatrix
 * ========================================================================= */

console.log('\n== 6. normalMatrix ==');

const S = MV.scale(2, 1, 0.5);
const NM = MV.normalMatrix(S);

expectArray('normalMatrix(scale(2,1,0.5)) == inverse(transpose(左上3x3))',
            NM, MV.inverse(MV.transpose(upper3(S))));

const scaledNormal = apply3(NM, [0, 0, 1]);
expectScalar('normalMatrix: 法线 (0,0,1) 经变换后仍平行于 (0,0,1)（单位化后点积 = 1）',
             scaledNormal[2] / norm3(scaledNormal), 1);
expectScalar('normalMatrix: 长度按 1/0.5 = 2 缩放', norm3(scaledNormal), 2);

// 复合变换：T * R * S，法线矩阵必须保证 n' 与变换后的两个切向量都正交。
const model = MV.mult(MV.translate(5, -2, 3),
               MV.mult(MV.rotate(37, [1, 2, 3]), MV.scale(2, 1, 0.5)));
const model3 = upper3(model);
const t1 = apply3(model3, [1, 0, 0]);
const t2 = apply3(model3, [0, 1, 0]);
const nWorld = apply3(MV.normalMatrix(model), [0, 0, 1]);
const nWorldUnit = nWorld.map((x) => x / norm3(nWorld));
const t1Unit = t1.map((x) => x / norm3(t1));
const t2Unit = t2.map((x) => x / norm3(t2));
const dotN1 = nWorldUnit[0] * t1Unit[0] + nWorldUnit[1] * t1Unit[1] + nWorldUnit[2] * t1Unit[2];
const dotN2 = nWorldUnit[0] * t2Unit[0] + nWorldUnit[1] * t2Unit[1] + nWorldUnit[2] * t2Unit[2];
expectScalar('normalMatrix 复合变换：n\' 与变换后切向量 t1 正交', dotN1, 0);
expectScalar('normalMatrix 复合变换：n\' 与变换后切向量 t2 正交', dotN2, 0);

/* =========================================================================
 * 九、inverse
 * ========================================================================= */

console.log('\n== 7. inverse ==');

const M = MV.mult(MV.translate(3, -4, 5),
          MV.mult(MV.rotate(33, [2, -1, 3]), MV.scale(2, 1, 0.5)));
expectArray('inverse(m) * m ≈ I（含旋转 / 平移 / 缩放的任意矩阵）',
            MV.mult(MV.inverse(M), M), MV.mat4(), 1e-6);
expectArray('m * inverse(m) ≈ I',
            MV.mult(M, MV.inverse(M)), MV.mat4(), 1e-6);

/* =========================================================================
 * 十、flatten / transpose / 列主序布局
 * ========================================================================= */

console.log('\n== 8. flatten / 列主序布局 ==');

const T = MV.translate(7, 8, 9);
expectScalar('translate(7,8,9): m[12] = 7', T[12], 7);
expectScalar('translate(7,8,9): m[13] = 8', T[13], 8);
expectScalar('translate(7,8,9): m[14] = 9', T[14], 9);

const F = MV.flatten(T);
check('flatten 返回 TypedArray（Float32Array）',
      ArrayBuffer.isView(F) && F.length === 16, 'Float32Array(16)', F);
expectScalar('flatten(m)[12] === 7（列主序平移量位于第 12 个元素）', F[12], 7);
expectArray('flatten 前 4 个元素 = 第 0 列 (1,0,0,0)',
            Array.from(F.slice(0, 4)), [1, 0, 0, 0]);

// 已经是 Float32Array 时直接返回同一个对象（避免每帧重复分配）
const sandboxFloat32 = vm.runInContext('new Float32Array(16)', sandbox);
check('flatten 遇到 Float32Array 时直接返回原对象',
      MV.flatten(sandboxFloat32) === sandboxFloat32, '同一个 Float32Array', '不是同一个对象');

const TT = MV.transpose(T);
expectArray('transpose(translate(7,8,9)) 的第 0 列 = (1,0,0,7)',
            [TT[0], TT[1], TT[2], TT[3]], [1, 0, 0, 7]);
expectArray('transpose(translate(7,8,9)) 的第 0 行 = (1,0,0,0)',
            [TT[0], TT[4], TT[8], TT[12]], [1, 0, 0, 0]);

/* =========================================================================
 * 十一、向量辅助函数
 * ========================================================================= */

console.log('\n== 9. 向量辅助函数 ==');

expectArray('cross([1,0,0],[0,1,0]) -> [0,0,1]',
            MV.cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
expectScalar('normalize([3,4,0]) 的长度为 1', MV.length(MV.normalize([3, 4, 0])), 1);
expectScalar('length([3,4,0]) = 5', MV.length([3, 4, 0]), 5);
expectScalar('dot([1,2,3],[4,5,6]) = 32', MV.dot([1, 2, 3], [4, 5, 6]), 32);
expectArray('add([1,2,3],[4,5,6]) -> [5,7,9]',
            MV.add([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
expectArray('subtract([4,5,6],[1,2,3]) -> [3,3,3]',
            MV.subtract([4, 5, 6], [1, 2, 3]), [3, 3, 3]);
check('equal([1,2,3],[1,2,3]) 为 true', MV.equal([1, 2, 3], [1, 2, 3]) === true, true, MV.equal([1, 2, 3], [1, 2, 3]));
check('equal([1,2,3],[1,2,4]) 为 false', MV.equal([1, 2, 3], [1, 2, 4]) === false, false, MV.equal([1, 2, 3], [1, 2, 4]));
expectScalar('radians(180) = PI', MV.radians(180), Math.PI);
expectScalar('degrees(PI) = 180', MV.degrees(Math.PI), 180);

/* =========================================================================
 * 十二、initShaders mock 冒烟测试
 * ========================================================================= */

console.log('\n== 10. initShaders（mock WebGL）==');

function createMockGL() {
  const state = {
    shaders: [],
    programs: [],
    deletedShaders: [],
    deletedPrograms: [],
    failShaderCompile: false,
    failProgramLink: false
  };
  const gl = {
    VERTEX_SHADER: 0x8B31,
    FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81,
    LINK_STATUS: 0x8B82,
    createShader(type) {
      const shader = {
        type,
        source: '',
        compiled: !state.failShaderCompile,
        infoLog: state.failShaderCompile ? 'ERROR: 0:1: syntax error' : ''
      };
      state.shaders.push(shader);
      return shader;
    },
    shaderSource(shader, source) { shader.source = source; },
    compileShader() { /* mock：编译结果由 createShader 预设 */ },
    getShaderParameter(shader) { return shader.compiled; },
    getShaderInfoLog(shader) { return shader.infoLog; },
    deleteShader(shader) { state.deletedShaders.push(shader); },
    createProgram() {
      const program = {
        shaders: [],
        linked: !state.failProgramLink,
        infoLog: state.failProgramLink ? 'ERROR: link failed: varying mismatch' : ''
      };
      state.programs.push(program);
      return program;
    },
    attachShader(program, shader) { program.shaders.push(shader); },
    linkProgram() { /* mock */ },
    getProgramParameter(program) { return program.linked; },
    getProgramInfoLog(program) { return program.infoLog; },
    deleteProgram(program) { state.deletedPrograms.push(program); }
  };
  return { gl, state };
}

{
  const { gl, state } = createMockGL();
  const shader = initShaders.createShader(gl, gl.VERTEX_SHADER, 'void main() { gl_Position = vec4(0.0); }');
  check('createShader 使用源码字符串创建 shader',
        !!shader && shader.source === 'void main() { gl_Position = vec4(0.0); }',
        'shader.source = 传入的源码', shader && shader.source);
  check('createShader 成功时没有删除 shader', state.deletedShaders.length === 0,
        0, state.deletedShaders.length);
}

{
  const { gl } = createMockGL();
  const shader = initShaders.createShader(gl, gl.VERTEX_SHADER, 'test-vs');
  check('createShader 支持 <script id> 形式的源码（自动读取 textContent）',
        shader.source === scriptElements['test-vs'].textContent,
        scriptElements['test-vs'].textContent, shader.source);
}

{
  const { gl } = createMockGL();
  const shader = initShaders.createShader(gl, gl.FRAGMENT_SHADER, scriptElements['test-fs']);
  check('createShader 支持直接传 <script> 元素对象',
        shader.source === scriptElements['test-fs'].textContent,
        scriptElements['test-fs'].textContent, shader.source);
}

{
  const { gl, state } = createMockGL();
  state.failShaderCompile = true;
  expectThrows('createShader 编译失败抛出含编译日志的 Error',
               () => initShaders.createShader(gl, gl.VERTEX_SHADER, 'void main() { }'),
               ['着色器编译失败', 'syntax error', 'void main()']);
  check('createShader 编译失败后删除 shader', state.deletedShaders.length === 1, 1, state.deletedShaders.length);
}

{
  const { gl, state } = createMockGL();
  const program = initShaders.createProgram(gl, 'test-vs', 'test-fs');
  check('createProgram 链接成功返回 program', !!program && program.linked === true, 'linked program', program);
  check('createProgram 成功时 attach 了 2 个 shader', program.shaders.length === 2, 2, program.shaders.length);
  check('createProgram 链接成功后释放 2 个 shader', state.deletedShaders.length === 2, 2, state.deletedShaders.length);
}

{
  const { gl, state } = createMockGL();
  state.failProgramLink = true;
  expectThrows('createProgram 链接失败抛出含链接日志的 Error',
               () => initShaders.createProgram(gl, 'test-vs', 'test-fs'),
               ['着色器程序链接失败', 'varying mismatch']);
  check('createProgram 链接失败后清理 program 与 shader',
        state.deletedPrograms.length === 1 && state.deletedShaders.length === 2,
        'program=1, shaders=2',
        'program=' + state.deletedPrograms.length + ', shaders=' + state.deletedShaders.length);
}

/* =========================================================================
 * 十三、WebGLUtils mock 冒烟测试
 * ========================================================================= */

console.log('\n== 11. WebGLUtils（mock canvas）==');

function createMockCanvas(factory) {
  const calls = [];
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: 300,
    clientHeight: 150,
    calls,
    getContext(type, attrs) {
      calls.push({ type, attrs });
      return factory(type, attrs, calls.length);
    }
  };
  return canvas;
}

{
  const fakeGL = { viewport() {} };
  const canvas = createMockCanvas((type, attrs, n) => (n === 1 ? null : fakeGL));
  const gl = WebGLUtils.setupWebGL(canvas, { antialias: true });
  check('setupWebGL 第一次失败后关闭抗锯齿重试并成功', gl === fakeGL, fakeGL, gl);
  check('setupWebGL 重试时 antialias = false', canvas.calls[1].attrs.antialias === false,
        false, canvas.calls[1].attrs.antialias);
  check('setupWebGL 只请求 webgl2 上下文',
        canvas.calls.every((c) => c.type === 'webgl2'), '全部为 webgl2',
        canvas.calls.map((c) => c.type));
}

{
  const fakeGL = { viewport() {} };
  const canvas = createMockCanvas(() => fakeGL);
  WebGLUtils.setupWebGL(canvas, {
    alpha: true,
    depth: false,
    preserveDrawingBuffer: true,
    antialias: false
  });
  const attrs = canvas.calls[0].attrs;
  check('setupWebGL 透传 options：alpha / depth / preserveDrawingBuffer',
        attrs.alpha === true && attrs.depth === false && attrs.preserveDrawingBuffer === true,
        'alpha=true, depth=false, preserveDrawingBuffer=true', attrs);
}

{
  const canvas = createMockCanvas(() => null);
  expectThrows('setupWebGL 完全失败时抛出可读的中文错误（含 WebGL 2.0 / 排查建议）',
               () => WebGLUtils.setupWebGL(canvas),
               ['WebGL 2.0', 'chrome://gpu']);
}

{
  const fakeGL = { tag: 'ctx-by-id' };
  const canvas = createMockCanvas(() => fakeGL);
  canvasElements['canvas-by-id'] = canvas;
  check('setupWebGL 支持传 canvas 的 id',
        WebGLUtils.setupWebGL('canvas-by-id') === fakeGL, fakeGL, '不同对象');
}

{
  const fakeGL = { tag: 'getContext' };
  const canvas = { getContext: (type) => (type === 'webgl2' ? fakeGL : null) };
  check('getContext 返回 webgl2 上下文', WebGLUtils.getContext(canvas) === fakeGL, fakeGL, '不同对象');
}

{
  // devicePixelRatio = 3，但库内把上限压到 2 → 300×150 CSS 像素变成 600×300 绘图缓冲
  sandbox.devicePixelRatio = 3;
  const viewportCalls = [];
  const gl = { viewport(...args) { viewportCalls.push(args); } };
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: 300,
    clientHeight: 150,
    getContext: () => null
  };
  const changed = WebGLUtils.resizeCanvasToDisplaySize(canvas, gl);
  check('resizeCanvasToDisplaySize 按 devicePixelRatio（上限 2）调整尺寸并返回 true',
        changed === true && canvas.width === 600 && canvas.height === 300,
        'true, 600x300', `${changed}, ${canvas.width}x${canvas.height}`);
  check('resizeCanvasToDisplaySize 同步设置 gl.viewport',
        viewportCalls.length === 1 && viewportCalls[0][2] === 600 && viewportCalls[0][3] === 300,
        '[0,0,600,300]', viewportCalls);
  const changedAgain = WebGLUtils.resizeCanvasToDisplaySize(canvas, gl);
  check('尺寸未变化时 resizeCanvasToDisplaySize 返回 false',
        changedAgain === false, false, changedAgain);
}

/* =========================================================================
 * 十二、本项目追加的 API / 手算值对照
 *     lib/MV.js 末尾追加了一段「AP3 补充 API」（vec2 / multScalar /
 *     mat4Inverse / mat3Inverse / mat3Transpose / lerp / clamp），
 *     这里逐项验证，确保追加没有破坏原 API、数值也正确。
 * ========================================================================= */

console.log('\n== 12. 本项目追加 API / 手算值对照 ==');

// --- vec2 / multScalar / lerp / clamp ---
expectArray('【追加】vec2(3, -4) -> [3, -4]', MV.vec2(3, -4), [3, -4]);
expectArray('【追加】vec2([3, -4]) 支持数组复制', MV.vec2([3, -4]), [3, -4]);
expectScalar('【追加】length(vec2(3, -4)) = 5', MV.length(MV.vec2(3, -4)), 5);
expectArray('【追加】multScalar(2, [1,2,3]) -> [2,4,6]',
            MV.multScalar(2, [1, 2, 3]), [2, 4, 6]);
expectArray('【追加】multScalar([1,2,3], 2) 参数顺序反过来也一样',
            MV.multScalar([1, 2, 3], 2), [2, 4, 6]);
expectThrows('【追加】multScalar 两个参数都不是标量时抛错',
             () => MV.multScalar([1], [2]), 'multScalar');
expectArray('【追加】lerp([0,0,0], [10,20,30], 0.5) -> [5,10,15]',
            MV.lerp([0, 0, 0], [10, 20, 30], 0.5), [5, 10, 15]);
expectScalar('【追加】clamp(5, 0, 1) = 1', MV.clamp(5, 0, 1), 1);
expectScalar('【追加】clamp(-5, 0, 1) = 0', MV.clamp(-5, 0, 1), 0);
expectScalar('【追加】clamp(0.25, 0, 1) 保持不变', MV.clamp(0.25, 0, 1), 0.25);

// --- mat4Inverse / mat3Inverse / mat3Transpose ---
expectArray('【追加】mat4Inverse(m) * m ≈ I',
            MV.mult(MV.mat4Inverse(M), M), MV.mat4(), 1e-6);
const M3 = upper3(M);
expectArray('【追加】mat3Inverse(M3) * M3 = I（3x3）',
            MV.mult(MV.mat3Inverse(M3), M3), MV.mat3(), 1e-6);
expectArray('【追加】mat3Transpose(M3) == transpose(M3)',
            MV.mat3Transpose(M3), MV.transpose(M3));
expectThrows('【追加】mat4Inverse 传入 3x3 时抛错',
             () => MV.mat4Inverse(M3), 'mat4Inverse');
expectThrows('【追加】mat3Inverse 传入 4x4 时抛错',
             () => MV.mat3Inverse(M), 'mat3Inverse');

// --- normalMatrix 对「纯旋转」等于旋转矩阵本身（旋转不改变法线长度）---
const Rpure = MV.rotate(57, [1, -2, 0.5]);
expectArray('normalMatrix(纯旋转) === 左上 3x3 本身（N = R，因为 R⁻ᵀ = R）',
            MV.normalMatrix(Rpure), upper3(Rpure), 1e-9);
expectArray('纯旋转矩阵正交：transpose(R3) * R3 = I',
            MV.mult(MV.mat3Transpose(upper3(Rpure)), upper3(Rpure)), MV.mat3(), 1e-9);

// --- 乘法结合顺序：mult(T, S) 先缩放后平移；mult(S, T) 先平移后缩放 ---
const Tt = MV.translate(1, 2, 3);
const Ss = MV.scale(2, 2, 2);
expectArray('mult(T,S) 作用于 (1,0,0)：先缩放再平移 -> (3,2,3)',
            project(MV.mult(Tt, Ss), [1, 0, 0]), [3, 2, 3]);
expectArray('mult(S,T) 作用于 (1,0,0)：先平移再缩放 -> (4,4,6)',
            project(MV.mult(Ss, Tt), [1, 0, 0]), [4, 4, 6]);
const Rr = MV.rotate(30, [0, 1, 0]);
expectArray('mult 满足结合律：(T·R)·S = T·(R·S)',
            MV.mult(MV.mult(Tt, Rr), Ss), MV.mult(Tt, MV.mult(Rr, Ss)), 1e-9);

// --- perspective：与手算值逐元素对照 ---
// perspective(60°, aspect=1.5, near=0.1, far=100)：
//   f = 1/tan(30°) = √3 ≈ 1.7320508075688772
//   m[0]  = f / 1.5            ≈ 1.1547005383792515
//   m[5]  = f                  ≈ 1.7320508075688772
//   m[10] = (far+near)/(near-far) = 100.1 / -99.9 ≈ -1.002002002002002
//   m[11] = -1
//   m[14] = 2·far·near/(near-far) = 20 / -99.9   ≈ -0.20020020020020018
//   m[15] = 0
const P60 = MV.perspective(60, 1.5, 0.1, 100);
expectArray('perspective(60,1.5,0.1,100) 与手算矩阵逐元素一致', P60, [
  1.1547005383792515, 0, 0, 0,
  0, 1.7320508075688772, 0, 0,
  0, 0, -1.002002002002002, -1,
  0, 0, -0.20020020020020018, 0
], 1e-12);
expectScalar('perspective 手算：m[0] = (1/tan30°)/aspect',
             P60[0], (1 / Math.tan(Math.PI / 6)) / 1.5, 1e-15);
expectScalar('perspective 手算：m[14] = 2·far·near/(near-far)',
             P60[14], (2 * 100 * 0.1) / (0.1 - 100), 1e-15);

// --- ortho：与手算值逐元素对照 ---
// ortho(-2, 2, -1, 1, 0.1, 100)：
//   m[0] = 2/(r-l) = 0.5      m[5] = 2/(t-b) = 1
//   m[10] = -2/(f-n) = -2/99.9 ≈ -0.02002002002002002
//   m[12] = -(r+l)/(r-l) = 0  m[13] = 0
//   m[14] = -(f+n)/(f-n) = -100.1/99.9 ≈ -1.002002002002002   m[15] = 1
const O2 = MV.ortho(-2, 2, -1, 1, 0.1, 100);
expectArray('ortho(-2,2,-1,1,0.1,100) 与手算矩阵逐元素一致', O2, [
  0.5, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, -0.02002002002002002, 0,
  0, 0, -1.002002002002002, 1
], 1e-12);

/* =========================================================================
 * 结果汇总
 * ========================================================================= */

console.log('\n========================================');
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.error('失败用例：');
  for (const name of failures) {
    console.error('  - ' + name);
  }
  process.exit(1);
} else {
  console.log('全部测试通过。');
  process.exit(0);
}

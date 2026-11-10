/**
 * tools/test-geometry.mjs —— src/geometry.js 的 Node 单元测试（零第三方依赖）
 * ------------------------------------------------------------------
 * 运行方式（在 AP3 目录下）：
 *     node tools/test-geometry.mjs
 *
 * 覆盖内容：
 *   1) 各数组长度自洽：positions / normals / tangents 都是 3 个 float / 顶点，
 *      uvs 是 2 个 float / 顶点，indices 是 3 的倍数，triangles = indices.length / 3；
 *   2) indices 每个值都是 < 顶点数的非负整数；
 *   3) 所有 normal / tangent 长度 ≈ 1，且 |dot(N, T)| ≈ 0（切空间基正交）；
 *   4) 所有 uv 都在 [0, 1] 内（允许 1e-6 的浮点误差）；
 *   5) 绕序：逐三角形算几何法线，与三个顶点法线的平均值点积 > 0 的比例；
 *      闭包几何体（cube/box/sphere/cylinder/cone/torus）要求 ≥ 99%，
 *      平面要求 100%；顺带要求没有零面积（退化）三角形；
 *   6) 包围盒 / 半径：sphere(0.5) 半径 0.5±1e-3；plane(1) 的 y 全为 0 且
 *      x/z ∈ [-0.5, 0.5]；torus(0.7,0.25) 的 x 范围 ≈ ±0.95 等；
 *   7) 参数下限保护：传入 0 / 负数 / 过小的 slices 时不产生 NaN，仍返回可用几何体；
 *   8) UV 等比：box(2,1,0.5) 的 +Z 面 u 铺满 [0,1]、v 只占一半（按面尺寸等比，不拉伸）；
 *   9) merge() 的顶点偏移 / 三角形数正确。
 *
 * 任何一项失败都会在末尾汇总并以退出码 1 结束；全部通过时打印 ALL TESTS PASSED。
 */
import {
  cube, box, plane, sphere, cylinder, cone, torus, merge
} from '../src/geometry.js';

/* =========================================================================
 * 一、微型断言框架
 * ========================================================================= */

let passed = 0;
const failures = [];

/** 断言。失败时记录并打印，最后统一退出码 1。 */
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
  } else {
    failures.push(name);
    console.error(`  [FAIL] ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

/** 数值接近断言（带上限误差）。 */
function checkClose(name, actual, expected, tolerance) {
  check(name, Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `期望 ${expected} ± ${tolerance}，实际 ${actual}`);
}

/* =========================================================================
 * 二、几何体数据的读取小工具
 * ========================================================================= */

function vertexCount(g) {
  return g.positions.length / 3;
}

function getPos(g, i) {
  return [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
}

function getNormal(g, i) {
  return [g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]];
}

function getTangent(g, i) {
  return [g.tangents[i * 3], g.tangents[i * 3 + 1], g.tangents[i * 3 + 2]];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function len3(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** 包围盒 { min: [x,y,z], max: [x,y,z] }。 */
function boundingBox(g) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const vc = vertexCount(g);
  for (let i = 0; i < vc; i++) {
    for (let k = 0; k < 3; k++) {
      const value = g.positions[i * 3 + k];
      if (value < min[k]) min[k] = value;
      if (value > max[k]) max[k] = value;
    }
  }
  return { min, max };
}

/* =========================================================================
 * 三、通用检查（对每个几何体都跑一遍）
 * ========================================================================= */

/**
 * @param {string} label  显示名
 * @param {object} g      几何体
 * @param {boolean} closed 是否闭包几何体（决定绕序阈值 99% / 100%）
 */
function runCommonChecks(label, g, closed) {
  const prefix = label + '：';
  const vc = vertexCount(g);

  // ---- 1) 数组长度自洽 ----
  check(prefix + 'positions 长度是 3 的倍数', g.positions.length % 3 === 0,
    `positions.length = ${g.positions.length}`);
  check(prefix + '顶点数是正整数', Number.isInteger(vc) && vc > 0, `顶点数 = ${vc}`);
  check(prefix + 'normals 与顶点数一致', g.normals.length === vc * 3,
    `normals.length = ${g.normals.length}，期望 ${vc * 3}`);
  check(prefix + 'tangents 与顶点数一致', g.tangents.length === vc * 3,
    `tangents.length = ${g.tangents.length}，期望 ${vc * 3}`);
  check(prefix + 'uvs 长度 = 2 × 顶点数', g.uvs.length === vc * 2,
    `uvs.length = ${g.uvs.length}，期望 ${vc * 2}`);
  check(prefix + 'indices 长度是 3 的倍数', g.indices.length % 3 === 0,
    `indices.length = ${g.indices.length}`);
  check(prefix + '三角形数 = indices.length / 3 且 > 0',
    g.triangles === g.indices.length / 3 && g.triangles > 0,
    `triangles = ${g.triangles}，indices.length/3 = ${g.indices.length / 3}`);

  // ---- 2) 索引范围 ----
  let badIndex = -1;
  for (let k = 0; k < g.indices.length; k++) {
    const value = g.indices[k];
    if (!Number.isInteger(value) || value < 0 || value >= vc) {
      badIndex = k;
      break;
    }
  }
  check(prefix + 'indices 每个值都是 < 顶点数的非负整数', badIndex === -1,
    `第 ${badIndex} 个索引越界`);

  // ---- 3) 法线 / 切线：单位长度 + 正交 ----
  let maxNormalErr = 0;
  let maxTangentErr = 0;
  let maxDotNT = 0;
  let hasNaN = false;
  for (let i = 0; i < vc; i++) {
    const n = getNormal(g, i);
    const t = getTangent(g, i);
    if (n.some((x) => !Number.isFinite(x)) || t.some((x) => !Number.isFinite(x))) {
      hasNaN = true;
      break;
    }
    maxNormalErr = Math.max(maxNormalErr, Math.abs(len3(n) - 1));
    maxTangentErr = Math.max(maxTangentErr, Math.abs(len3(t) - 1));
    maxDotNT = Math.max(maxDotNT, Math.abs(dot3(n, t)));
  }
  check(prefix + '没有 NaN / Infinity 顶点数据', !hasNaN);
  check(prefix + 'normals 都是单位向量（误差 < 1e-3）', maxNormalErr < 1e-3,
    `最大长度误差 ${maxNormalErr}`);
  check(prefix + 'tangents 都是单位向量（误差 < 1e-3）', maxTangentErr < 1e-3,
    `最大长度误差 ${maxTangentErr}`);
  check(prefix + '切线与法线正交（|N·T| < 1e-3）', maxDotNT < 1e-3,
    `最大 |N·T| = ${maxDotNT}`);

  // ---- 4) UV 范围 + 接缝 0→1 ----
  let minU = Infinity;
  let maxU = -Infinity;
  let uvOutOfRange = false;
  let uvHasNaN = false;
  for (let i = 0; i < vc; i++) {
    const u = g.uvs[i * 2];
    const v = g.uvs[i * 2 + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      uvHasNaN = true;
      break;
    }
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) {
      uvOutOfRange = true;
    }
  }
  check(prefix + 'uv 没有 NaN', !uvHasNaN);
  check(prefix + 'uv 全部落在 [0, 1] 区间（容差 1e-6）', !uvOutOfRange,
    '存在越界 uv');
  check(prefix + 'u 从 0 连续展开到 1（接缝处复制顶点）',
    minU <= 1e-6 && maxU >= 1 - 1e-6,
    `u 范围 [${minU}, ${maxU}]`);

  // ---- 5) 绕序 + 退化三角形 ----
  let outward = 0;
  let inward = 0;
  let degenerate = 0;
  for (let k = 0; k < g.indices.length; k += 3) {
    const i0 = g.indices[k];
    const i1 = g.indices[k + 1];
    const i2 = g.indices[k + 2];
    const p0 = getPos(g, i0);
    const p1 = getPos(g, i1);
    const p2 = getPos(g, i2);
    const faceNormal = cross3(sub3(p1, p0), sub3(p2, p0));
    const faceLen = len3(faceNormal);
    if (faceLen < 1e-12) {
      degenerate += 1;
      continue;
    }
    // 三个顶点法线的平均值（未归一化，用点积符号判断方向即可）
    const n0 = getNormal(g, i0);
    const n1 = getNormal(g, i1);
    const n2 = getNormal(g, i2);
    const avg = [
      (n0[0] + n1[0] + n2[0]) / 3,
      (n0[1] + n1[1] + n2[1]) / 3,
      (n0[2] + n1[2] + n2[2]) / 3
    ];
    if (dot3(faceNormal, avg) / faceLen > 0) {
      outward += 1;
    } else {
      inward += 1;
    }
  }
  const total = outward + inward;
  const ratio = total > 0 ? outward / total : 0;
  const minRatio = closed ? 0.99 : 1.0;
  check(prefix + `逆时针绕序（面法线与顶点法线同向）比例 ≥ ${(minRatio * 100).toFixed(0)}%`,
    ratio >= minRatio - 1e-9,
    `outward ${outward} / inward ${inward}（比例 ${(ratio * 100).toFixed(2)}%）`);
  check(prefix + '没有零面积（退化）三角形', degenerate === 0,
    `退化三角形 ${degenerate} 个`);
}

/* =========================================================================
 * 四、逐个几何体的专项检查
 * ========================================================================= */

console.log('== geometry.js 单元测试 ==');

const cases = [
  { name: 'cube(1)', g: cube(1), closed: true },
  { name: 'box(2, 1, 0.5)', g: box(2, 1, 0.5), closed: true },
  { name: 'plane(1)', g: plane(1), closed: false },
  { name: 'sphere(0.5, 24, 48)', g: sphere(0.5, 24, 48), closed: true },
  { name: 'cylinder(0.5, 1, 48)', g: cylinder(0.5, 1, 48), closed: true },
  { name: 'cone(0.5, 1, 48)', g: cone(0.5, 1, 48), closed: true },
  { name: 'torus(0.7, 0.25, 64, 32)', g: torus(0.7, 0.25, 64, 32), closed: true },
  {
    name: 'merge(cube(0.4), sphere(0.3, 8, 16))',
    g: merge(cube(0.4), sphere(0.3, 8, 16)),
    closed: true
  }
];

for (const { name, g, closed } of cases) {
  runCommonChecks(name, g, closed);
}

/* ---- 4.1 包围盒 / 半径 ---- */

{
  const g = sphere(0.5, 24, 48);
  const bbox = boundingBox(g);
  const vc = vertexCount(g);
  let maxRadiusErr = 0;
  for (let i = 0; i < vc; i++) {
    const p = getPos(g, i);
    maxRadiusErr = Math.max(maxRadiusErr, Math.abs(len3(p) - 0.5));
  }
  check('sphere(0.5)：所有顶点到原点距离 = 0.5 ± 1e-3', maxRadiusErr <= 1e-3,
    `最大误差 ${maxRadiusErr}`);
  checkClose('sphere(0.5)：包围盒 x 最小 ≈ -0.5', bbox.min[0], -0.5, 1e-3);
  checkClose('sphere(0.5)：包围盒 x 最大 ≈ +0.5', bbox.max[0], 0.5, 1e-3);
  checkClose('sphere(0.5)：包围盒 y 最小 ≈ -0.5', bbox.min[1], -0.5, 1e-3);
  checkClose('sphere(0.5)：包围盒 y 最大 ≈ +0.5', bbox.max[1], 0.5, 1e-3);
  checkClose('sphere(0.5)：包围盒 z 最小 ≈ -0.5', bbox.min[2], -0.5, 1e-3);
  checkClose('sphere(0.5)：包围盒 z 最大 ≈ +0.5', bbox.max[2], 0.5, 1e-3);
}

{
  const g = plane(1);
  const bbox = boundingBox(g);
  const vc = vertexCount(g);
  let allOnXZ = true;
  let inRange = true;
  for (let i = 0; i < vc; i++) {
    const p = getPos(g, i);
    if (Math.abs(p[1]) > 1e-6) allOnXZ = false;
    if (p[0] < -0.5 - 1e-6 || p[0] > 0.5 + 1e-6 ||
        p[2] < -0.5 - 1e-6 || p[2] > 0.5 + 1e-6) {
      inRange = false;
    }
  }
  check('plane(1)：所有顶点 y 恒为 0（XZ 平面）', allOnXZ);
  check('plane(1)：所有顶点 x / z ∈ [-0.5, 0.5]', inRange);
  checkClose('plane(1)：x 范围 = 1（包围盒 min ≈ -0.5）', bbox.min[0], -0.5, 1e-6);
  checkClose('plane(1)：x 范围 = 1（包围盒 max ≈ +0.5）', bbox.max[0], 0.5, 1e-6);
  checkClose('plane(1)：z 范围 = 1（包围盒 min ≈ -0.5）', bbox.min[2], -0.5, 1e-6);
  checkClose('plane(1)：z 范围 = 1（包围盒 max ≈ +0.5）', bbox.max[2], 0.5, 1e-6);
  // 平面法线全部 +Y
  const vc2 = vertexCount(g);
  let normalOk = true;
  for (let i = 0; i < vc2; i++) {
    const n = getNormal(g, i);
    if (Math.abs(n[0]) > 1e-6 || Math.abs(n[1] - 1) > 1e-6 || Math.abs(n[2]) > 1e-6) {
      normalOk = false;
    }
  }
  check('plane(1)：法线全部为 (0, 1, 0)', normalOk);
}

{
  const g = torus(0.7, 0.25, 64, 32);
  const bbox = boundingBox(g);
  checkClose('torus(0.7,0.25)：x 最小 ≈ -0.95', bbox.min[0], -0.95, 1e-3);
  checkClose('torus(0.7,0.25)：x 最大 ≈ +0.95', bbox.max[0], 0.95, 1e-3);
  checkClose('torus(0.7,0.25)：z 最小 ≈ -0.95', bbox.min[2], -0.95, 1e-3);
  checkClose('torus(0.7,0.25)：z 最大 ≈ +0.95', bbox.max[2], 0.95, 1e-3);
  checkClose('torus(0.7,0.25)：y 范围 = ±r = ±0.25', bbox.min[1], -0.25, 1e-3);
  checkClose('torus(0.7,0.25)：y 范围 = ±r = ±0.25', bbox.max[1], 0.25, 1e-3);
}

{
  const g = cube(2);
  const bbox = boundingBox(g);
  checkClose('cube(2)：包围盒 x = ±1', bbox.min[0], -1, 1e-6);
  checkClose('cube(2)：包围盒 x = ±1', bbox.max[0], 1, 1e-6);
  checkClose('cube(2)：包围盒 y = ±1', bbox.min[1], -1, 1e-6);
  checkClose('cube(2)：包围盒 y = ±1', bbox.max[1], 1, 1e-6);
  checkClose('cube(2)：包围盒 z = ±1', bbox.min[2], -1, 1e-6);
  checkClose('cube(2)：包围盒 z = ±1', bbox.max[2], 1, 1e-6);
  check('cube(2)：顶点数 24 / 三角形数 12',
    vertexCount(g) === 24 && g.triangles === 12,
    `${vertexCount(g)} 顶点 / ${g.triangles} 三角形`);
}

{
  const g = box(2, 1, 0.5);
  const bbox = boundingBox(g);
  checkClose('box(2,1,0.5)：包围盒 x = ±1', bbox.min[0], -1, 1e-6);
  checkClose('box(2,1,0.5)：包围盒 x = ±1', bbox.max[0], 1, 1e-6);
  checkClose('box(2,1,0.5)：包围盒 y = ±0.5', bbox.min[1], -0.5, 1e-6);
  checkClose('box(2,1,0.5)：包围盒 y = ±0.5', bbox.max[1], 0.5, 1e-6);
  checkClose('box(2,1,0.5)：包围盒 z = ±0.25', bbox.min[2], -0.25, 1e-6);
  checkClose('box(2,1,0.5)：包围盒 z = ±0.25', bbox.max[2], 0.25, 1e-6);

  // +Z 面（法线 (0,0,1)）的 UV：u 铺满 [0,1]、v 只占 0.5（1/2 物理高度）→ 等比不拉伸
  const vc = vertexCount(g);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < vc; i++) {
    const n = getNormal(g, i);
    if (Math.abs(n[2] - 1) < 1e-6) {
      const u = g.uvs[i * 2];
      const v = g.uvs[i * 2 + 1];
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }
  checkClose('box(2,1,0.5)：+Z 面 u 跨度为 1（宽 2 = 最长边）', maxU - minU, 1, 1e-6);
  checkClose('box(2,1,0.5)：+Z 面 v 跨度为 0.5（高 1 是最长边的一半）',
    maxV - minV, 0.5, 1e-6);
  checkClose('box(2,1,0.5)：+Z 面 UV 居中（v 中心 = 0.5）', (minV + maxV) / 2, 0.5, 1e-6);
}

{
  const g = cylinder(0.5, 1, 48);
  const bbox = boundingBox(g);
  checkClose('cylinder(0.5,1)：包围盒 y = ±0.5', bbox.min[1], -0.5, 1e-6);
  checkClose('cylinder(0.5,1)：包围盒 y = ±0.5', bbox.max[1], 0.5, 1e-6);
  checkClose('cylinder(0.5,1)：半径（x 最大）= 0.5', bbox.max[0], 0.5, 1e-6);
  checkClose('cylinder(0.5,1)：半径（z 最大）= 0.5', bbox.max[2], 0.5, 1e-6);
}

{
  const g = cone(0.5, 1, 48);
  const bbox = boundingBox(g);
  checkClose('cone(0.5,1)：包围盒 y = ±0.5', bbox.min[1], -0.5, 1e-6);
  checkClose('cone(0.5,1)：包围盒 y = ±0.5', bbox.max[1], 0.5, 1e-6);
  checkClose('cone(0.5,1)：底面半径（x 最大）= 0.5', bbox.max[0], 0.5, 1e-6);
  checkClose('cone(0.5,1)：底面半径（z 最大）= 0.5', bbox.max[2], 0.5, 1e-6);
}

/* ---- 4.2 参数下限保护 ---- */

{
  const guarded = [
    ['sphere(0.5, 1, 2)', sphere(0.5, 1, 2)],
    ['cylinder(0.5, 1, 1)', cylinder(0.5, 1, 1)],
    ['cone(0.5, 1, 1)', cone(0.5, 1, 1)],
    ['torus(0.7, 0.25, 1, 1)', torus(0.7, 0.25, 1, 1)],
    ['box(0, 0, 0)（非法尺寸退默认 1）', box(0, 0, 0)],
    ['sphere(-1)（负半径退默认 0.5）', sphere(-1)],
    ['cylinder(0.5, 1, NaN)', cylinder(0.5, 1, NaN)]
  ];
  for (const [name, g] of guarded) {
    const vc = vertexCount(g);
    let finite = true;
    for (let i = 0; i < g.positions.length; i++) {
      if (!Number.isFinite(g.positions[i])) { finite = false; break; }
    }
    check('参数下限保护：' + name + ' 仍返回有效几何体',
      finite && g.triangles > 0 && g.indices.length > 0,
      `顶点 ${vc}，三角形 ${g.triangles}`);
  }
}

/* ---- 4.3 merge() 合并正确性 ---- */

{
  const a = cube(0.4);
  const b = sphere(0.3, 8, 16);
  const m = merge(a, b);
  const va = vertexCount(a);
  const vb = vertexCount(b);
  check('merge()：顶点数 = 两个几何体顶点数之和',
    vertexCount(m) === va + vb, `${vertexCount(m)} vs ${va + vb}`);
  check('merge()：三角形数 = 两个几何体三角形数之和',
    m.triangles === a.triangles + b.triangles,
    `${m.triangles} vs ${a.triangles + b.triangles}`);
  check('merge()：第二个几何体的索引被正确偏移',
    m.indices[0] === a.indices[0] &&
    m.indices[a.indices.length] === b.indices[0] + va,
    `第 ${a.indices.length} 个索引 = ${m.indices[a.indices.length]}，期望 ${b.indices[0] + va}`);
  const empty = merge();
  check('merge()：无参数时返回空几何体（triangles = 0）',
    empty.triangles === 0 && empty.positions.length === 0 && empty.indices.length === 0);
}

/* =========================================================================
 * 五、结果汇总 + 顶点数 / 三角形数表格
 * ========================================================================= */

console.log('\n--------------------------------------------------------------------------');
console.log('几何体                                  顶点数      三角形数');
console.log('--------------------------------------------------------------------------');
for (const { name, g } of cases) {
  const nameCell = name.length > 38 ? name.slice(0, 37) + '…' : name;
  console.log(nameCell.padEnd(40) + String(vertexCount(g)).padStart(8) +
              String(g.triangles).padStart(12));
}
console.log('--------------------------------------------------------------------------');
console.log(`通过 ${passed} 项断言，失败 ${failures.length} 项`);

if (failures.length > 0) {
  console.error('\n失败项：');
  for (const name of failures) {
    console.error('  - ' + name);
  }
  process.exit(1);
}

console.log('\nALL TESTS PASSED');

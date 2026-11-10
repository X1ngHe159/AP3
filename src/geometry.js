/**
 * src/geometry.js —— 程序化几何体生成器（纯 ES Module，零依赖，手写数学）
 * ------------------------------------------------------------------
 * 本文件不 import MV.js（lib/ 里的是经典脚本，且几何生成只需要最基础的向量运算），
 * 所有坐标都在「模型空间」里直接算出来，导出函数返回普通对象：
 *
 *   {
 *     positions: Float32Array,  // 3 个 float / 顶点（x, y, z）
 *     normals:   Float32Array,  // 3 个 float / 顶点（单位外法线 N）
 *     uvs:       Float32Array,  // 2 个 float / 顶点（u, v，范围 [0,1]）
 *     tangents:  Float32Array,  // 3 个 float / 顶点（单位切向量 T，沿 +U 方向）
 *     indices:   Uint32Array,   // 三角形索引（gl.TRIANGLES，配合 gl.UNSIGNED_INT）
 *     triangles: number         // 三角形个数 = indices.length / 3
 *   }
 *
 * 绘制约定（渲染器需配合）：
 *   - gl.drawElements(gl.TRIANGLES, g.indices.length, gl.UNSIGNED_INT, 0)；
 *     WebGL 2.0 原生支持 32 位索引，大球/大环面也不会超出 65535 顶点。
 *   - 三角形绕序为逆时针（CCW，右手定则），即「正面朝外」；配合
 *     gl.cullFace(gl.BACK) + gl.frontFace(gl.CCW) 时外表面可见。
 *
 * ============================ 三条重要约定 ============================
 *
 * 1) 绕序（winding）
 *    每个三角形 (p0, p1, p2) 的几何法线 cross(p1 - p0, p2 - p0) 都与三个顶点的
 *    平均法线同向（点积 > 0）。球体/圆柱/圆锥/环面在「极点 / 接缝」处会跳过退化
 *    三角形，因此没有零面积三角形，全部三角形的绕序都是对的。
 *
 * 2) UV 与 v 方向（贴图不要倒置）
 *    纹理加载时使用 gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)，因此
 *        v = 0 对应纹理图片的「底边」，v = 1 对应图片「顶边」。
 *    为了让人眼常见的贴图（例如地球、砖墙）正立，竖直方向的参数取
 *        v = 1 - polar / PI
 *    即北极 v = 1、南极 v = 0（图片顶部在北极）。
 *    u 一律等于「绕轴角度 / 2π」，从 0 连续展开到 1（接缝处复制顶点，因此
 *    u 不会出现负数或 >1 的值）。
 *    平面 plane() 的 u 沿 +X；为了让 (T, B=N×T, N) 构成右手系，v 沿 -Z
 *    （v = 0 在 z = +size/2 那一侧）。立方体 / 长方体每个面都是右手系。
 *
 * 3) 切线 T（供法线贴图使用）
 *    T = normalize(∂P/∂u) 再对 N 做 Gram-Schmidt 正交化（T -= N·(N·T) 后归一化），
 *    保证 T 是单位向量且与 N 严格正交。切空间的手性按「B = ∂P/∂v」定义：
 *        handedness = sign( dot( cross(N, T), B ) )
 *      cube / box / plane        : +1（右手系，B = cross(N, T)）
 *      sphere/cylinder/cone/torus: -1（左手系，B = -cross(N, T)）
 *    曲线曲面的 -1 是由「图片正立」（v = 1 - polar/π）决定的，属于正常现象：
 *    着色器里若要构建 TBN 且贴的是切线空间法线贴图，应使用
 *        vec3 B = cross(N, T) * handedness;
 *    或者只对 cube/box/plane（本项目法线贴图只贴在地面 / 木箱 / 墙上）使用切线空间
 *    法线贴图，曲线物体用屏幕空间导数 TBN 即可。
 *    圆柱 / 圆锥的圆盘盖法线恒定，切线固定取 +X（u 方向），盖子是平面，
 *    手性差异不影响光照（顶盖 v 沿 -Z、底盖 v 沿 +Z，均为右手系）。
 *
 * ============================ 参数化公式 ============================
 *   cube/box   : 6 个轴对齐面，每个面 4 顶点 2 三角形；UV 按面尺寸等比映射（不拉伸）
 *   plane      : XZ 平面，y = 0，法线 +Y，居中于原点
 *   sphere     : P(θ, φ) = (R sinφ cosθ, R cosφ, R sinφ sinθ)
 *                φ ∈ [0, π] 为极角（0 = 北极），θ ∈ [0, 2π] 为绕 Y 轴方位角
 *                N = (sinφ cosθ, cosφ, sinφ sinθ)，T = (-sinθ, 0, cosθ)
 *   cylinder   : 侧面 P(θ, y) = (R cosθ, y, R sinθ)，y ∈ [-H/2, H/2]
 *                N = (cosθ, 0, sinθ)，T = (-sinθ, 0, cosθ)；上下各一个圆盘盖
 *   cone       : 底面半径 R 在 y = -H/2，锥尖在 (0, H/2, 0)
 *                侧面 N(θ) ∝ (H cosθ, R, H sinθ)（斜率 H/R 决定法线向上倾）
 *                T = (-sinθ, 0, cosθ)；底面一个圆盘盖
 *   torus      : P(θ, φ) = ((R + r cosφ) cosθ, r sinφ, (R + r cosφ) sinθ)
 *                θ 绕 Y 轴（环的大圈），φ 绕管截面（小圈），两者都在 [0, 2π]
 *                N = (cosφ cosθ, sinφ, cosφ sinθ)，T = (-sinθ, 0, cosθ)
 * =====================================================================
 */

const TAU = Math.PI * 2;

/* =========================================================================
 * 一、参数下限保护与基础工具
 * ========================================================================= */

/** 有限数则返回，否则返回 fallback。 */
function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** 取正数：非有限或 <= 0 时退回默认值（半径 / 高度不能是 0 或负数）。 */
function positiveOr(value, fallback) {
  const v = finiteOr(value, fallback);
  return v > 0 ? v : fallback;
}

/**
 * 取整数并保证不小于 min：slices / stacks / segments 这类参数必须是整数。
 * 非有限值退回 fallback，太小则被抬到 min（例如 slices 至少 3 才能围成圈）。
 */
function intAtLeast(value, min, fallback) {
  let n = Math.floor(Number(value));
  if (!Number.isFinite(n)) {
    n = fallback;
  }
  if (n < min) {
    n = min;
  }
  return n;
}

/** 三维叉积。 */
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

/** 归一化向量；零向量返回输入副本（几何生成里不该出现，防御性处理）。 */
function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-12) {
    return [0, 0, 0];
  }
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * 让切线 T 成为与法线 N 正交的单位向量（Gram-Schmidt）。
 *   T' = normalize(T - N * dot(N, T))
 * 若 T 与 N 平行（退化，理论上不会发生），则任选一个与 N 垂直的轴兜底。
 * 这一步保证「法线贴图的 TBN 基」是正交的，也保证单元测试里 |N·T| ≈ 0。
 */
function orthoTangent(n, t) {
  const d = n[0] * t[0] + n[1] * t[1] + n[2] * t[2];
  let x = t[0] - n[0] * d;
  let y = t[1] - n[1] * d;
  let z = t[2] - n[2] * d;
  let len = Math.hypot(x, y, z);
  if (len < 1e-12) {
    // T 与 N 平行：取与 N 最不平行的坐标轴做叉积得到备用切线
    const axis = Math.abs(n[0]) < Math.abs(n[1])
      ? (Math.abs(n[0]) < Math.abs(n[2]) ? [1, 0, 0] : [0, 0, 1])
      : (Math.abs(n[1]) < Math.abs(n[2]) ? [0, 1, 0] : [0, 0, 1]);
    return normalize(cross(n, axis));
  }
  return [x / len, y / len, z / len];
}

/* =========================================================================
 * 二、顶点 / 索引装配器
 * ========================================================================= */

/** 收集裸数组，最后一次性转换成 Float32Array / Uint32Array。 */
class Builder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.tangents = [];
    this.indices = [];
  }

  /**
   * 追加一个顶点，返回顶点索引。
   * 这里统一做两件事，调用方就不用重复写：
   *   1) 法线归一化；
   *   2) 切线对法线做 Gram-Schmidt 正交化。
   */
  add(p, n, t, u, v) {
    const id = this.positions.length / 3;
    const unitNormal = normalize(n);
    const unitTangent = orthoTangent(unitNormal, t);

    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(unitNormal[0], unitNormal[1], unitNormal[2]);
    this.tangents.push(unitTangent[0], unitTangent[1], unitTangent[2]);
    this.uvs.push(u, v);
    return id;
  }

  /** 追加一个三角形（CCW）。 */
  tri(a, b, c) {
    this.indices.push(a, b, c);
  }

  /** 生成最终几何体对象。 */
  result() {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      tangents: new Float32Array(this.tangents),
      indices: new Uint32Array(this.indices),
      triangles: this.indices.length / 3
    };
  }
}

/* =========================================================================
 * 三、立方体 / 长方体
 * ========================================================================= */

/**
 * 六个面的局部坐标系：n 为外法线，t 为 +U 方向（单位轴向量）。
 * +V 方向取 b = cross(n, t)，于是 (T, B, N) 为右手系，且绕序 (p0,p1,p2) 的
 * 几何法线 = cross(t, b) = n（逆时针朝外）。
 */
const BOX_FACES = [
  { n: [1, 0, 0], t: [0, 0, -1] },  // +X 面：u 沿 -Z，v 沿 +Y
  { n: [-1, 0, 0], t: [0, 0, 1] },  // -X 面
  { n: [0, 1, 0], t: [1, 0, 0] },   // +Y 面（顶面）
  { n: [0, -1, 0], t: [1, 0, 0] },  // -Y 面（底面）
  { n: [0, 0, 1], t: [1, 0, 0] },   // +Z 面：u 沿 +X，v 沿 +Y
  { n: [0, 0, -1], t: [-1, 0, 0] }  // -Z 面
];

/**
 * box(w, h, d) —— 轴对齐长方体，中心在原点，边长 w/h/d。
 *
 * UV 规则：每个面的 u/v 范围 = 该面实际物理尺寸 / 最长边。
 *   最长边的那个面 UV 正好铺满 [0,1]，其它面取中间的一段（居中），
 *   因此纹理在各面上「每单位长度的纹素数相同」——不会被拉伸变形，
 *   也不会出现 >1 的 UV（不需要 REPEAT 包装，虽然渲染器可以开）。
 *   例：box(2, 1, 0.5)，scale = 2：
 *     +Z 面（2×1）   u ∈ [0, 1]，v ∈ [0.25, 0.75]
 *     +Y 面（2×0.5） u ∈ [0, 1]，v ∈ [0.375, 0.625]
 */
export function box(w, h, d) {
  const W = positiveOr(w, 1);
  const H = positiveOr(h, 1);
  const D = positiveOr(d, 1);
  const size = [W, H, D];
  // 等密度基准：最长边对应 UV 1.0，其它面按比例缩小
  const scale = Math.max(W, H, D);

  const b = new Builder();

  for (const face of BOX_FACES) {
    const n = face.n;
    const t = face.t;
    const bt = cross(n, t); // +V 方向，单位轴向量

    // t / bt 都是轴向量，物理尺寸 = |分量| 加权边长
    const uSize = Math.abs(t[0]) * W + Math.abs(t[1]) * H + Math.abs(t[2]) * D;
    const vSize = Math.abs(bt[0]) * W + Math.abs(bt[1]) * H + Math.abs(bt[2]) * D;

    // 面中心（n 是轴向量，所以直接取对应半边长）
    const cx = n[0] * W / 2;
    const cy = n[1] * H / 2;
    const cz = n[2] * D / 2;

    // 四个角的局部坐标 (su, sv) ∈ {-1,+1}²，顺序决定绕序
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const ids = [];
    for (const [su, sv] of corners) {
      const lu = su * uSize / 2;   // 沿 +U 的局部偏移
      const lv = sv * vSize / 2;   // 沿 +V 的局部偏移
      const p = [
        cx + t[0] * lu + bt[0] * lv,
        cy + t[1] * lu + bt[1] * lv,
        cz + t[2] * lu + bt[2] * lv
      ];
      // 居中映射到 [0,1] 中的一段
      const u = 0.5 + lu / scale;
      const v = 0.5 + lv / scale;
      ids.push(b.add(p, n, t, u, v));
    }
    // cross(p1-p0, p2-p0) = cross(t, bt) = n → 逆时针朝外
    b.tri(ids[0], ids[1], ids[2]);
    b.tri(ids[0], ids[2], ids[3]);
  }

  return b.result();
}

/**
 * cube(size = 1) —— 边长为 size 的轴对齐立方体，中心在原点。
 * 等价于 box(size, size, size)：每个面 UV 都正好铺满 [0,1]。
 */
export function cube(size = 1) {
  const s = positiveOr(size, 1);
  return box(s, s, s);
}

/* =========================================================================
 * 四、平面
 * ========================================================================= */

/**
 * plane(size = 1) —— XZ 平面（y = 0），法线 +Y，居中于原点。
 *
 * 参数化：x = (u - 0.5) * size，z = (0.5 - v) * size
 * 即 u 沿 +X，v 沿 -Z（右手系：T × B = (1,0,0) × (0,0,-1) = (0,1,0) = N）。
 * 四个角点顺序为 (0,0) (1,0) (1,1) (0,1)，索引 (0,1,2) (0,2,3) 使绕序为 CCW。
 */
export function plane(size = 1) {
  const S = positiveOr(size, 1);
  const half = S / 2;
  const b = new Builder();
  const n = [0, 1, 0];
  const t = [1, 0, 0];

  // 角点：先按纹理坐标 (u,v) 从 (0,0) 开始逆时针排列
  const corners = [
    { p: [-half, 0, half], u: 0, v: 0 },   // 左上（-X, +Z）
    { p: [half, 0, half], u: 1, v: 0 },    // 右上
    { p: [half, 0, -half], u: 1, v: 1 },   // 右下
    { p: [-half, 0, -half], u: 0, v: 1 }   // 左下
  ];
  const ids = corners.map((c) => b.add(c.p, n, t, c.u, c.v));
  b.tri(ids[0], ids[1], ids[2]);
  b.tri(ids[0], ids[2], ids[3]);

  return b.result();
}

/* =========================================================================
 * 五、球体
 * ========================================================================= */

/**
 * sphere(radius = 0.5, stacks = 24, slices = 48)
 *
 * 参数化（球坐标）：
 *   P(θ, φ) = ( R sinφ cosθ,   R cosφ,   R sinφ sinθ )
 *   φ ∈ [0, π]  极角，0 = 北极(+Y)，π = 南极(-Y)         → 沿 stacks 方向分段
 *   θ ∈ [0, 2π] 方位角，绕 +Y 轴                        → 沿 slices 方向分段
 *
 * 法线 / 切线：
 *   N = (sinφ cosθ, cosφ, sinφ sinθ)  （就是 P/R，单位向量朝外）
 *   T = (-sinθ, 0, cosθ)              （∂P/∂θ 的归一化，沿 +U 方向，与 N 严格正交）
 *   UV：u = θ / 2π ∈ [0, 1]；v = 1 - φ/π ∈ [0, 1]（北极 v=1、南极 v=0，图片正立）
 *
 * 顶点排布：行 i = 0..stacks 对应 φ（i=0 北极，i=stacks 南极），
 *           列 j = 0..slices 对应 θ（接缝列 j=slices 与 j=0 位置重合、u=1）。
 * 极点行是「slices+1 个位置相同但 u 不同的顶点」，因此每个极点四边面会退化成
 * 一个有效三角形 + 一个零面积三角形；本实现直接跳过零面积的那个（见下方索引循环），
 * 保证没有任何退化三角形、绕序检查 100% 通过。
 */
export function sphere(radius = 0.5, stacks = 24, slices = 48) {
  const R = positiveOr(radius, 0.5);
  const ST = intAtLeast(stacks, 2, 24);
  const SL = intAtLeast(slices, 3, 48);

  const rows = ST + 1;
  const cols = SL + 1;
  const b = new Builder();

  for (let i = 0; i < rows; i++) {
    const phi = Math.PI * i / ST;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const v = 1 - i / ST; // 北极 1 → 南极 0

    for (let j = 0; j < cols; j++) {
      const theta = TAU * j / SL;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      const p = [
        R * sinPhi * cosTheta,
        R * cosPhi,
        R * sinPhi * sinTheta
      ];
      const n = [sinPhi * cosTheta, cosPhi, sinPhi * sinTheta];
      // ∂P/∂θ = R sinφ * (-sinθ, 0, cosθ) → 归一化后极点处也成立
      const t = [-sinTheta, 0, cosTheta];

      b.add(p, n, t, j / SL, v);
    }
  }

  const at = (i, j) => i * cols + j;

  for (let i = 0; i < ST; i++) {
    for (let j = 0; j < SL; j++) {
      const a = at(i, j);         // (φ_i,   θ_j)
      const b2 = at(i + 1, j);    // (φ_{i+1}, θ_j)
      const c = at(i + 1, j + 1); // (φ_{i+1}, θ_{j+1})
      const d = at(i, j + 1);     // (φ_i,   θ_{j+1})

      // 行方向 = +φ，列方向 = +θ；解析求导得 ∂φ × ∂θ = -N，
      // 所以这里必须用「反序」的 (a,c,b) / (a,d,c) 才能得到朝外的逆时针绕序。
      if (i === 0) {
        // 北极那一行：a、d 都在极点（位置相同），(a,d,c) 退化 → 跳过
        b.tri(a, c, b2);
      } else if (i === ST - 1) {
        // 南极那一行：b、c 都在极点，(a,c,b) 退化 → 跳过
        b.tri(a, d, c);
      } else {
        b.tri(a, c, b2);
        b.tri(a, d, c);
      }
    }
  }

  return b.result();
}

/* =========================================================================
 * 六、圆柱 / 圆锥的公共圆盘盖
 * ========================================================================= */

/**
 * 追加一个圆盘盖（三角形扇形）。
 *   up = +1 → 顶盖（法线 +Y，位于 y），up = -1 → 底盖（法线 -Y，位于 y）
 *
 * UV 采用圆盘平面映射：把圆盘 (x, z) 线性映射到以 (0.5, 0.5) 为圆心、
 * 半径 0.5 的圆内：
 *   u = 0.5 + x / (2R)
 *   顶盖 v = 0.5 - z / (2R)，底盖 v = 0.5 + z / (2R)
 * 这样两个盖子的 (T, B, N) 都是右手系（T = +X 固定为 u 方向），
 * 且 u / v 都严格落在 [0, 1] 内。
 *
 * 绕序：π 平面里 cross(ring_i, ring_{i+1}) = -Y，所以
 *   顶盖用 (center, ring_{j+1}, ring_j) → 几何法线 +Y；
 *   底盖用 (center, ring_j, ring_{j+1}) → 几何法线 -Y。
 */
function addCap(b, radius, y, up, slices) {
  const n = [0, up, 0];
  const t = [1, 0, 0];
  const centerId = b.add([0, y, 0], n, t, 0.5, 0.5);

  const ring = [];
  for (let j = 0; j <= slices; j++) {
    const theta = TAU * j / slices;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    const x = radius * cosTheta;
    const z = radius * sinTheta;
    const u = 0.5 + x / (2 * radius);
    const v = up > 0 ? 0.5 - z / (2 * radius) : 0.5 + z / (2 * radius);
    ring.push(b.add([x, y, z], n, t, u, v));
  }

  for (let j = 0; j < slices; j++) {
    if (up > 0) {
      b.tri(centerId, ring[j + 1], ring[j]);
    } else {
      b.tri(centerId, ring[j], ring[j + 1]);
    }
  }
}

/* =========================================================================
 * 七、圆柱
 * ========================================================================= */

/**
 * cylinder(radius = 0.5, height = 1, slices = 48) —— 轴向 +Y，含上下盖。
 *
 * 侧面参数化：
 *   P(θ, y) = ( R cosθ, y, R sinθ )，y ∈ [-H/2, H/2]，θ ∈ [0, 2π]
 *   N = (cosθ, 0, sinθ)（径向朝外）
 *   T = (-sinθ, 0, cosθ)（∂P/∂θ 归一化，沿 +U）
 *   UV：u = θ / 2π，v = (y + H/2) / H（底边 v=0、顶边 v=1，图片正立）
 * 绕序：行方向 +Y、列方向 +θ 满足 (+Y) × ∂θ = +N，因此自然顺序 (a,b,c)/(a,c,d)
 *       就是逆时针朝外（与球体相反，球体的行方向是 +φ）。
 * 盖子见 addCap()。
 */
export function cylinder(radius = 0.5, height = 1, slices = 48) {
  const R = positiveOr(radius, 0.5);
  const H = positiveOr(height, 1);
  const SL = intAtLeast(slices, 3, 48);
  const half = H / 2;
  const cols = SL + 1;
  const b = new Builder();

  // 侧面：2 行（底 / 顶）× (SL+1) 列
  for (let row = 0; row < 2; row++) {
    const y = row === 0 ? -half : half;
    const v = row; // 0 = 底，1 = 顶
    for (let j = 0; j < cols; j++) {
      const theta = TAU * j / SL;
      const cosTheta = Math.cos(theta);
      const sinTheta = Math.sin(theta);
      b.add(
        [R * cosTheta, y, R * sinTheta],
        [cosTheta, 0, sinTheta],
        [-sinTheta, 0, cosTheta],
        j / SL,
        v
      );
    }
  }

  const at = (row, j) => row * cols + j;
  for (let j = 0; j < SL; j++) {
    const a = at(0, j);
    const b2 = at(1, j);
    const c = at(1, j + 1);
    const d = at(0, j + 1);
    b.tri(a, b2, c);
    b.tri(a, c, d);
  }

  // 上下盖
  addCap(b, R, half, 1, SL);
  addCap(b, R, -half, -1, SL);

  return b.result();
}

/* =========================================================================
 * 八、圆锥
 * ========================================================================= */

/**
 * cone(radius = 0.5, height = 1, slices = 48) —— 轴向 +Y，含底面。
 *
 * 几何：底面圆半径 R 位于 y = -H/2，锥尖位于 (0, H/2, 0)，总高 H。
 * 侧面参数化（母线方向 + 圆周方向）：
 *   P(θ, s) = ( (1-s) R cosθ, -H/2 + s H, (1-s) R sinθ )，s ∈ [0,1] 从底到尖
 *   侧面外法线（与高度的斜率有关）：
 *     N(θ) = normalize( H cosθ, R, H sinθ )
 *   例如 R=0.5, H=1 时，底部圆周法线约 (0.894 cosθ, 0.447, 0.894 sinθ)，
 *   即锥面法线向 +Y 倾斜（圆锥侧面是斜的，这是正确的）。
 *   T = (-sinθ, 0, cosθ)（∂P/∂θ 归一化，沿 +U）
 *   UV：u = θ / 2π，v = s（底边 v=0、锥尖 v=1，图片正立）
 *
 * 绕序：行方向（母线向上）× 列方向（+θ）= 朝外的 N，所以三角形取
 *   (base_j, apex, base_{j+1}) 顺序即为逆时针朝外。
 * 锥尖是「每个切片一个独立顶点」的扇形（n 取该切片中间角度的解析法线），
 * 这样锥面的高光不会在锥尖处出现奇怪的接缝；底面见 addCap()。
 */
export function cone(radius = 0.5, height = 1, slices = 48) {
  const R = positiveOr(radius, 0.5);
  const H = positiveOr(height, 1);
  const SL = intAtLeast(slices, 3, 48);
  const half = H / 2;
  const b = new Builder();

  // 锥面法线的归一化系数（一次性算好）
  const invLen = 1 / Math.hypot(H, R);

  for (let j = 0; j < SL; j++) {
    const theta = TAU * j / SL;
    const thetaNext = TAU * (j + 1) / SL;
    const thetaMid = (theta + thetaNext) / 2;

    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);

    // 底圆上的两个顶点
    const baseId = b.add(
      [R * cosTheta, -half, R * sinTheta],
      [H * cosTheta * invLen, R * invLen, H * sinTheta * invLen],
      [-sinTheta, 0, cosTheta],
      j / SL,
      0
    );
    const baseNextId = b.add(
      [R * Math.cos(thetaNext), -half, R * Math.sin(thetaNext)],
      [H * Math.cos(thetaNext) * invLen, R * invLen, H * Math.sin(thetaNext) * invLen],
      [-Math.sin(thetaNext), 0, Math.cos(thetaNext)],
      (j + 1) / SL,
      0
    );

    // 锥尖：每个切片一个顶点，u 取切片中点，法线取中点角度的解析法线
    const apexId = b.add(
      [0, half, 0],
      [H * Math.cos(thetaMid) * invLen, R * invLen, H * Math.sin(thetaMid) * invLen],
      [-Math.sin(thetaMid), 0, Math.cos(thetaMid)],
      (j + 0.5) / SL,
      1
    );

    // (base_j, apex, base_{j+1})：几何法线朝外（见上面的绕序推导）
    b.tri(baseId, apexId, baseNextId);
  }

  // 底面
  addCap(b, R, -half, -1, SL);

  return b.result();
}

/* =========================================================================
 * 九、环面（甜甜圈）
 * ========================================================================= */

/**
 * torus(R = 0.7, r = 0.25, segU = 64, segV = 32) —— 绕 +Y 轴的环面。
 *
 * 参数化：
 *   P(θ, φ) = ( (R + r cosφ) cosθ,  r sinφ,  (R + r cosφ) sinθ )
 *   θ ∈ [0, 2π]：绕 +Y 轴的大圈（环的主方向）→ 沿 segU 分段
 *   φ ∈ [0, 2π]：绕管截面的小圈                  → 沿 segV 分段
 *   R 为环心半径，r 为管半径（要求 R > r 才不会自交，这里只做下限保护：
 *   r 会被限制为 < R；若传反了则按 R/2 处理并保持环面形状）。
 *   法线：N = (cosφ cosθ, sinφ, cosφ sinθ)（单位、朝外）
 *   切线：T = (-sinθ, 0, cosθ)（∂P/∂θ 归一化，沿 +U）
 *   UV：u = θ / 2π，v = φ / 2π；φ = 0 是环的外侧赤道（v=0），
 *       φ = π/2 是管截面顶部（v=0.25），φ = π 是内侧（v=0.5）。
 *       环面是闭合曲面，没有「上下」概念，v 只要求连续 0→1。
 *
 * 绕序：行方向 +φ、列方向 +θ 满足 ∂φ × ∂θ = +N，因此自然顺序
 *   (a,b,c)/(a,c,d) 就是逆时针朝外（与球体相反，球体的行方向是 +φ 但
 *   它的 φ 从北极往下走，∂φ × ∂θ = -N）。
 */
export function torus(R = 0.7, r = 0.25, segU = 64, segV = 32) {
  const RR = positiveOr(R, 0.7);
  // 管半径必须小于环半径，否则管子穿过自己，法线/包围盒都会失真
  const rrRaw = positiveOr(r, 0.25);
  const rr = rrRaw < RR ? rrRaw : RR / 2;

  const SU = intAtLeast(segU, 3, 64);
  const SV = intAtLeast(segV, 3, 32);

  const rows = SV + 1;
  const cols = SU + 1;
  const b = new Builder();

  for (let i = 0; i < rows; i++) {
    const phi = TAU * i / SV;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const ringRadius = RR + rr * cosPhi;
    const v = i / SV;

    for (let j = 0; j < cols; j++) {
      const theta = TAU * j / SU;
      const cosTheta = Math.cos(theta);
      const sinTheta = Math.sin(theta);

      const p = [
        ringRadius * cosTheta,
        rr * sinPhi,
        ringRadius * sinTheta
      ];
      const n = [cosPhi * cosTheta, sinPhi, cosPhi * sinTheta];
      const t = [-sinTheta, 0, cosTheta];

      b.add(p, n, t, j / SU, v);
    }
  }

  const at = (i, j) => i * cols + j;
  for (let i = 0; i < SV; i++) {
    for (let j = 0; j < SU; j++) {
      const a = at(i, j);
      const b2 = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      // ∂φ × ∂θ = +N → 自然顺序即逆时针朝外
      b.tri(a, b2, c);
      b.tri(a, c, d);
    }
  }

  return b.result();
}

/* =========================================================================
 * 十、合并几何体
 * ========================================================================= */

/**
 * merge(...geometries) —— 把多个几何体合并成一个（用于组合物体，如「桌子」）。
 *
 * 做法：positions/normals/uvs/tangents 直接首尾拼接；indices 加上前面所有
 * 几何体的顶点数偏移。要求每个输入都是本文件导出的几何体对象。
 * 合并后仍保持每个子几何体原本的绕序 / UV / 切线，不做任何重新计算。
 */
export function merge(...geometries) {
  const parts = geometries.filter((g) => g && g.positions && g.indices);
  if (parts.length === 0) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      tangents: new Float32Array(0),
      indices: new Uint32Array(0),
      triangles: 0
    };
  }

  let positionCount = 0;   // 浮点数个数（= 顶点数 × 3）
  let indexCount = 0;
  for (const g of parts) {
    positionCount += g.positions.length;
    indexCount += g.indices.length;
  }

  const positions = new Float32Array(positionCount);
  const normals = new Float32Array(positionCount);
  const tangents = new Float32Array(positionCount);
  const uvs = new Float32Array(positionCount / 3 * 2);
  const indices = new Uint32Array(indexCount);

  let posOffset = 0;   // 浮点数偏移
  let uvOffset = 0;
  let idxOffset = 0;
  let vertexOffset = 0; // 顶点数偏移

  for (const g of parts) {
    positions.set(g.positions, posOffset);
    normals.set(g.normals, posOffset);
    tangents.set(g.tangents, posOffset);
    uvs.set(g.uvs, uvOffset);
    for (let k = 0; k < g.indices.length; k++) {
      indices[idxOffset + k] = g.indices[k] + vertexOffset;
    }
    posOffset += g.positions.length;
    uvOffset += g.uvs.length;
    idxOffset += g.indices.length;
    vertexOffset += g.positions.length / 3;
  }

  return {
    positions,
    normals,
    uvs,
    tangents,
    indices,
    triangles: indices.length / 3
  };
}

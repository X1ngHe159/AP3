/**
 * src/mat.js —— 渲染器内部用的最小矩阵/向量数学库（列主序，与 OpenGL 约定一致）
 * ------------------------------------------------------------------
 * 为什么项目里已经有了教材 lib/MV.js 还要这个文件？
 *   1) 相机、投影、逆矩阵（天空盒射线重建需要 inverse(viewProj)）属于"引擎内部"计算，
 *      这里集中实现，避免在渲染代码里到处做 flatten / 类型转换；
 *   2) 教材 MV.js 仍在使用：场景的模型矩阵在 src/scene.js 里用 MV.translate / MV.rotate /
 *      MV.scale / MV.mult 按教材 Ch4 的方式手工构造，满足课程"使用教材配套工具库"的要求。
 * 列主序：m[0..3] 是第一列（x 轴），m[12..14] 是平移分量。
 */

export const DEG = Math.PI / 180;

/** 单位矩阵 */
export function identity(out = new Float32Array(16)) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/** out = a * b（先施加 b，再施加 a） */
export function multiply(a, b, out = new Float32Array(16)) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[i * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[i * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    out[i * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return out;
}

/** 透视投影（fovy 单位为度，使用 1/tan 的标准形式） */
export function perspective(fovyDeg, aspect, near, far, out = new Float32Array(16)) {
  const f = 1.0 / Math.tan((fovyDeg * DEG) / 2.0);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1.0;
  out[14] = (2.0 * far * near) / (near - far);
  return out;
}

/** 正交投影 */
export function ortho(left, right, bottom, top, near, far, out = new Float32Array(16)) {
  out.fill(0);
  out[0] = 2.0 / (right - left);
  out[5] = 2.0 / (top - bottom);
  out[10] = -2.0 / (far - near);
  out[12] = -(right + left) / (right - left);
  out[13] = -(top + bottom) / (top - bottom);
  out[14] = -(far + near) / (far - near);
  out[15] = 1.0;
  return out;
}

/** 视图矩阵（右乘，eye→center，up 决定滚转） */
export function lookAt(eye, center, up, out = new Float32Array(16)) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;
  // x = normalize(cross(up, z))
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;
  // y = cross(z, x)
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

/** 4×4 逆矩阵（伴随矩阵法，来源于 gl-matrix 的经典实现） */
export function invert(m, out = new Float32Array(16)) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return identity(out);
  det = 1.0 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/** 法线矩阵 = transpose(inverse(upper-left 3×3))，返回 mat3（Float32Array 9） */
export function normalMatrix(m, out = new Float32Array(9)) {
  const a = m[0], b = m[1], c = m[2];
  const d = m[4], e = m[5], f = m[6];
  const g = m[8], h = m[9], i = m[10];
  // 3×3 逆（伴随矩阵 ÷ 行列式）
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  let det = a * A + b * B + c * C;
  if (!det) return out.fill(0), (out[0] = out[4] = out[8] = 1), out;
  det = 1.0 / det;
  // inverse 的转置 = 伴随矩阵 / det（列主序写入）
  out[0] = A * det;
  out[1] = B * det;
  out[2] = C * det;
  out[3] = (c * h - b * i) * det;
  out[4] = (a * i - c * g) * det;
  out[5] = (b * g - a * h) * det;
  out[6] = (b * f - c * e) * det;
  out[7] = (c * d - a * f) * det;
  out[8] = (a * e - b * d) * det;
  return out;
}

/** 模型矩阵：M = T · Rz · Ry · Rx · S（rotation 为角度，ZYX 顺序） */
export function composeTRS(position, rotationDeg, scale, out = new Float32Array(16)) {
  const cx = Math.cos(rotationDeg[0] * DEG), sx = Math.sin(rotationDeg[0] * DEG);
  const cy = Math.cos(rotationDeg[1] * DEG), sy = Math.sin(rotationDeg[1] * DEG);
  const cz = Math.cos(rotationDeg[2] * DEG), sz = Math.sin(rotationDeg[2] * DEG);

  // R = Rz * Ry * Rx
  const m00 = cz * cy;
  const m01 = cz * sy * sx - sz * cx;
  const m02 = cz * sy * cx + sz * sx;
  const m10 = sz * cy;
  const m11 = sz * sy * sx + cz * cx;
  const m12 = sz * sy * cx - cz * sx;
  const m20 = -sy;
  const m21 = cy * sx;
  const m22 = cy * cx;

  const sxScale = scale[0], syScale = scale[1], szScale = scale[2];
  out[0] = m00 * sxScale; out[1] = m10 * sxScale; out[2] = m20 * sxScale; out[3] = 0;
  out[4] = m01 * syScale; out[5] = m11 * syScale; out[6] = m21 * syScale; out[7] = 0;
  out[8] = m02 * szScale; out[9] = m12 * szScale; out[10] = m22 * szScale; out[11] = 0;
  out[12] = position[0]; out[13] = position[1]; out[14] = position[2]; out[15] = 1;
  return out;
}

/* ------------------------- 向量小工具 ------------------------- */

export function vec3(x = 0, y = 0, z = 0) { return new Float32Array([x, y, z]); }

export function add3(a, b, out = new Float32Array(3)) {
  out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
  return out;
}

export function sub3(a, b, out = new Float32Array(3)) {
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
  return out;
}

export function mul3(a, s, out = new Float32Array(3)) {
  out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
  return out;
}

export function unit3(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return new Float32Array([a[0] / l, a[1] / l, a[2] / l]);
}

export function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

export function cross3(a, b, out = new Float32Array(3)) {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/** 变换点（w = 1，透视除法） */
export function transformPoint4(m, p, out = new Float32Array(4)) {
  const x = p[0], y = p[1], z = p[2], w = p[3] === undefined ? 1 : p[3];
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
  return out;
}

/** 把一个 [x,y,z] 转成便于调试的字符串 */
export function fmt3(v, digits = 2) {
  return `(${v[0].toFixed(digits)}, ${v[1].toFixed(digits)}, ${v[2].toFixed(digits)})`;
}

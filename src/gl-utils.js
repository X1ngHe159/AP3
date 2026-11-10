/**
 * src/gl-utils.js —— WebGL 2.0 底层小工具
 * ------------------------------------------------------------------
 * 职责：编译着色器 / 创建 VAO / 上传纹理 / 创建深度 FBO / 全屏三角形 / 画布尺寸管理。
 * 上层的 src/renderer.js、src/shadow.js、src/picking.js 只调用这里的函数，不直接写样板代码。
 *
 * 着色器编译优先使用教材 Common 库的 initShaders（window.initShaders），
 * 拿不到时退回到本文件的实现（保证项目对 Common/ 的依赖是"优先使用"而非"硬依赖"）。
 */

/* ================================================================== */
/*  1. 上下文                                                            */
/* ================================================================== */

/**
 * 创建 WebGL 2.0 上下文；失败返回 null（调用方负责显示 #error-box）。
 */
export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: true,
    depth: true,
    stencil: false,
    alpha: false,
    preserveDrawingBuffer: true, // 让"保存截图"与 headless 截图都能读到画面
    premultipliedAlpha: false,
    powerPreference: 'high-performance'
  });
  if (!gl) return null;
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(gl.CCW);
  gl.clearColor(0.055, 0.07, 0.09, 1.0);
  return gl;
}

/** 画布跟随 CSS 尺寸与设备像素比（上限 2，避免高分屏性能崩） */
export function resizeCanvas(gl, canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

/* ================================================================== */
/*  2. 着色器 / 程序                                                      */
/* ================================================================== */

function compileShader(gl, type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`[${label}] 着色器编译失败：${log}`);
  }
  return shader;
}

/**
 * 编译 + 链接一个程序。
 * 优先用教材 initShaders（window.initShaders.createProgram(gl, vs, fs)），失败再自己来。
 */
export function createProgram(gl, vertexSource, fragmentSource, label = 'program') {
  if (window.initShaders && typeof window.initShaders.createProgram === 'function') {
    try {
      const program = window.initShaders.createProgram(gl, vertexSource, fragmentSource);
      if (program) return program;
    } catch (err) {
      // 教材库报错时用自己的实现再试一次，便于拿到更精确的日志
      console.warn(`[initShaders] ${label} 编译失败，回退到内置实现：`, err.message);
    }
  }
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource, `${label}:VS`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label}:FS`);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`[${label}] 程序链接失败：${log}`);
  }
  return program;
}

/**
 * 一次性取出程序里所有 uniform 的位置，避免渲染循环里反复 getUniformLocation。
 * 返回 { name: WebGLUniformLocation } 的普通对象。
 */
export function uniformLocations(gl, program, names) {
  const locs = {};
  for (const name of names) locs[name] = gl.getUniformLocation(program, name);
  return locs;
}

/* ================================================================== */
/*  3. 顶点数组对象                                                       */
/* ================================================================== */

/** 顶点属性槽位（与所有顶点着色器里的 layout(location=…) 一致） */
export const ATTRIB = { POSITION: 0, NORMAL: 1, TEXCOORD: 2, TANGENT: 3 };

/**
 * 由三角形索引生成去重后的线段索引（线框模式用）。
 * 每个三角形 3 条边，排过序的顶点对做 key 去重。
 */
function buildLineIndices(indices) {
  const seen = new Set();
  const lines = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const edges = [[a, b], [b, c], [c, a]];
    for (const [u, v] of edges) {
      const lo = u < v ? u : v;
      const hi = u < v ? v : u;
      const key = lo * 4294967296 + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(u, v);
    }
  }
  return new Uint32Array(lines);
}

/**
 * 由 src/geometry.js 的几何数据创建 VAO（三角形 + 线框两套索引共用同一批顶点缓冲）。
 * @returns {{vao, lineVao, indexCount, lineIndexCount, indexType, triangles}}
 */
export function createMesh(gl, geometry) {
  // 1) 顶点缓冲（4 个属性各一个 VBO，交错也可以，这里用分离布局便于讲解）
  const buffers = [];
  const attach = (location, data, size) => {
    const buffer = gl.createBuffer();
    buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  };

  const is32 = geometry.indices instanceof Uint32Array;
  const indexType = is32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

  // 2) 索引缓冲：三角形 + 线框（两种 VAO 共享顶点缓冲）
  const triangleIndices = geometry.indices;
  const lineIndices = buildLineIndices(triangleIndices);

  const makeVao = (indexArray) => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    attach(ATTRIB.POSITION, geometry.positions, 3);
    attach(ATTRIB.NORMAL, geometry.normals, 3);
    attach(ATTRIB.TEXCOORD, geometry.uvs, 2);
    attach(ATTRIB.TANGENT, geometry.tangents, 3);
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, indexBuffer };
  };

  const tri = makeVao(triangleIndices);
  const line = makeVao(lineIndices);

  return {
    vao: tri.vao,
    indexBuffer: tri.indexBuffer,
    lineVao: line.vao,
    lineIndexBuffer: line.indexBuffer,
    buffers,
    indexCount: triangleIndices.length,
    lineIndexCount: lineIndices.length,
    indexType,
    triangles: geometry.triangles || triangleIndices.length / 3
  };
}

/** 全屏三角形（覆盖整个裁剪空间），用于天空盒 / 全屏后处理 / 深度图小窗 */
export function createFullscreenTriangle(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, buffer };
}

/* ================================================================== */
/*  4. 纹理                                                              */
/* ================================================================== */

/** 上传一张位图纹理（REPEAT 平铺 + 三线性 mipmap），并处理"上下颠倒"问题 */
export function createTexture2D(gl, image, { flipY = true, repeat = true, srgb = false } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);
  return tex;
}

/** 上传立方体环境贴图（6 张图，顺序 +X,-X,+Y,-Y,+Z,-Z） */
export function createCubemap(gl, images) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  const faces = [
    gl.TEXTURE_CUBE_MAP_POSITIVE_X, gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Y, gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Z, gl.TEXTURE_CUBE_MAP_NEGATIVE_Z
  ];
  for (let i = 0; i < 6; i++) {
    gl.texImage2D(faces[i], 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, images[i]);
  }
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
  return tex;
}

/* ================================================================== */
/*  5. 阴影用的帧缓冲对象                                                 */
/* ================================================================== */

/**
 * 阴影贴图（第一遍渲染的目标）：只有深度附件，一张 2D 深度纹理。
 * 用 DEPTH_COMPONENT24 + NEAREST，第二遍着色器里手工比较深度。
 */
export function createShadowFBO(gl, size) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0,
    gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // 让深度比较"只存不比较"（这里用普通 sampler2D 手工比较，不启用 compare 模式）

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`阴影 FBO 不完整（status=${status}）`);
  }
  return { framebuffer, texture, size };
}

/**
 * 点光源阴影：一张立方体深度纹理 + 一个 FBO（逐面重新挂载）。
 */
export function createPointShadowFBO(gl, size) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
  for (let i = 0; i < 6; i++) {
    gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.DEPTH_COMPONENT24,
      size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  }
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
    gl.TEXTURE_CUBE_MAP_POSITIVE_X, texture, 0);
  gl.drawBuffers([gl.NONE]);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`点光阴影 FBO 不完整（status=${status}）`);
  }
  return { framebuffer, texture, size };
}

/** 颜色附件 FBO（拾取 pass / 拾取调试显示用），带深度渲染缓冲 */
export function createColorFBO(gl, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const depthBuffer = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`颜色 FBO 不完整（status=${status}）`);
  }
  return { framebuffer, texture, width, height, depthBuffer };
}

/* ================================================================== */
/*  6. 拾取颜色编码                                                       */
/* ================================================================== */

/**
 * 把物体序号编码成 RGB（0..1 浮点），写入拾取着色器的 uPickColor。
 * 编码方式：id = r + g*256 + b*65536（r/g/b 各 8 bit）。
 */
export function encodePickColor(id) {
  const r = id & 0xff;
  const g = (id >> 8) & 0xff;
  const b = (id >> 16) & 0xff;
  return [r / 255, g / 255, b / 255];
}

/** 从 readPixels 的 RGBA 字节反解物体序号（0 = 背景） */
export function decodePickColor(bytes) {
  return bytes[0] + bytes[1] * 256 + bytes[2] * 65536;
}

/* ================================================================== */
/*  7. 其它小工具                                                         */
/* ================================================================== */

/** 上传 vec3 数组到 uniform（自动去掉多余分量） */
export function setUniform3f(gl, loc, v) {
  if (loc) gl.uniform3f(loc, v[0], v[1], v[2]);
}

/** 颜色 × 强度（光源颜色预先乘上强度，着色器里少一次乘法） */
export function premultiplyColor(color, intensity) {
  return [color[0] * intensity, color[1] * intensity, color[2] * intensity];
}

/** 加载一张图片（Promise 版） */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片加载失败：${src}`));
    img.src = src;
  });
}

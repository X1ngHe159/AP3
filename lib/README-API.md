# lib/ API 参考（AP3 · 教材 Common 工具库）

本目录从 AP2 移植，共三个**经典脚本**（IIFE 立即执行函数，无模块语法），
用普通 `<script src>` 加载即可，只会在 `window` 上挂三个全局名：

| 文件 | 全局名 | 作用 |
|---|---|---|
| `lib/webgl-utils.js` | `window.WebGLUtils` | 创建 WebGL 2.0 上下文、画布尺寸管理 |
| `lib/initShaders.js` | `window.initShaders` | 编译 / 链接着色器，报错带行号源码 |
| `lib/MV.js` | `window.MV` | 教材第 4 章风格的矩阵 / 向量数学库 |

`index.html` 里的引入顺序（必须在 ES module 之前）：

```html
<script src="lib/webgl-utils.js"></script>
<script src="lib/initShaders.js"></script>
<script src="lib/MV.js"></script>
<script type="module" src="src/main.js"></script>
```

在 `src/` 的 ES module 里直接使用全局名即可（例如 `const { MV } = window;`）。

> 本文件与 AP2 的同名文件**内容一致**（AP2 的 `lib/` 直接拷贝过来），
> 唯一的改动是：`MV.js` 末尾**追加**了「本项目（AP3）补充 API」，
> 见第 1.8 节；AP2 的既有代码 / 调用方式完全不受影响。

---

## 1. `MV.js` —— 矩阵 / 向量数学库

### 1.1 总体约定（务必先读）

- **数据结构**：矩阵和向量都是**普通 JavaScript 数组**，也接受 `Float32Array` 作为输入。
- **列主序（column-major）**：与 WebGL 一致。
  `mat4` 的第 0 列 = `m[0..3]`，第 1 列 = `m[4..7]`，第 2 列 = `m[8..11]`，第 3 列 = `m[12..15]`；
  用 (行, 列) 记号表示 `M(r, c)` 存放在 `m[c * 4 + r]`（`mat3` 为 `m[c * 3 + r]`）。
- **作用方式**：作用于列向量 `p' = M · p`；`MV.mult(A, B) = A·B`，含义是**先作用 B，再作用 A**。
  （例如 `mult(translate(...), rotate(...))` = 先旋转后平移。）
- **角度单位**：`rotate(angle, axis)` 的 `angle`、`perspective(fovy, ...)` 的 `fovy`
  都是**度（degree）**，库内部自己转弧度。
- **纯函数**：所有函数都返回**新数组**，绝不原地修改传入的矩阵 / 向量。
- **上传 GPU**：用 `MV.flatten(m)` 转成 `Float32Array`；
  `uniformMatrix4fv(loc, false, MV.flatten(mat4))`（`transpose` 参数保持 `false`，因为本来就是列主序）。

### 1.2 构造

| API | 返回值 | 说明 |
|---|---|---|
| `mat4()` | `Array(16)` | 4×4 单位矩阵（列主序） |
| `mat4(m)` | `Array(16)` | 复制一个长度为 16 的矩阵（便于「先克隆再改」） |
| `mat3()` | `Array(9)` | 3×3 单位矩阵（列主序） |
| `mat3(m)` | `Array(9)` | 复制 3×3；若传 4×4 则取**左上角 3×3** |
| `vec3(x, y, z)` | `Array(3)` | 也支持 `vec3([x, y, z])` 复制；缺省分量 0 |
| `vec4(x, y, z, w)` | `Array(4)` | 也支持 `vec4([x, y, z])`（w 默认 1）；缺省 `[0, 0, 0, 1]` |

### 1.3 矩阵乘法

| API | 说明 |
|---|---|
| `mult(A, B)` | `A·B`，支持 4×4×4×4 与 3×3×3×3；返回新数组 |

### 1.4 基本变换（平移 / 旋转 / 缩放）

三种变换都有「生成」和「右乘到已有矩阵」两种调用形式，行为约定：

| API | 说明 |
|---|---|
| `translate(tx, ty, tz)` | 生成平移矩阵 T |
| `translate(m, tx, ty, tz)` | 返回 `m · T`（便利形式 `translate([tx,ty,tz])`、`translate(m, [tx,ty,tz])` 也支持） |
| `rotate(angleDeg, axis)` | 生成绕任意轴（`[x,y,z]`，内部自动归一化）旋转 `angleDeg` 度的矩阵 R（罗德里格斯公式） |
| `rotate(m, angleDeg, axis)` | 返回 `m · R`（= 在 m 的局部坐标系里再旋转） |
| `scale(sx, sy, sz)` | 生成缩放矩阵 S（便利形式 `scale([sx,sy,sz])`） |
| `scale(m, sx, sy, sz)` | 返回 `m · S` |

> 注意：模型矩阵通常是 `T · R · S`（先缩放、再旋转、最后平移），
> 代码写法是 `MV.mult(T, MV.mult(R, S))` 或逐步 `m = MV.scale(...); m = MV.rotate(m, ...); m = MV.translate(m, ...)`。

### 1.5 投影 / 视图

| API | 说明 |
|---|---|
| `perspective(fovyDeg, aspect, near, far)` | 4×4 透视投影；`fovyDeg` 为**垂直**视场角（度）；要求 `aspect>0`、`near>0`、`far>near`，否则抛错 |
| `ortho(left, right, bottom, top, near, far)` | 4×4 正交投影，把视图空间长方体映射到 NDC `[-1,1]³` |
| `lookAt(eye, at, up)` | 4×4 视图矩阵；`eye/at/up` 都是 `[x,y,z]`；`up` 与视线平行时抛错 |

### 1.6 矩阵辅助

| API | 说明 |
|---|---|
| `transpose(m)` | 转置，支持 4×4 / 3×3 |
| `inverse(m)` | 求逆，支持 4×4 / 3×3；行列式接近 0 时抛错 |
| `normalMatrix(m)` | 取左上 3×3 的**逆转置** `(M₃₋₃⁻¹)ᵀ`，返回 `Array(9)`。含非等比缩放时**必须**用它变换法线，不能直接用模型矩阵的 3×3 |
| `flatten(m)` | 转 `Float32Array`（已经是 `Float32Array` 时直接返回原对象，不复制）；`uniformMatrix3fv/4fv` 用 |

### 1.7 向量 / 标量辅助

| API | 说明 |
|---|---|
| `cross(a, b)` | 三维叉积 |
| `normalize(v)` | 归一化（零向量返回零向量，不会出 NaN） |
| `dot(a, b)` | 点积（要求维度相同） |
| `add(a, b)` / `subtract(a, b)` | 逐分量加 / 减 |
| `length(v)` | 欧几里得范数 |
| `equal(a, b, eps=1e-6)` | 容差比较，返回布尔 |
| `radians(deg)` / `degrees(rad)` | 角度 / 弧度换算 |

### 1.8 【本项目追加】补充 API（`MV.js` 末尾的补丁段）

原版教材 `MV.js` **没有** `vec2`、也没有「向量乘标量」这类函数；AP3 需要它们，
因此在 `lib/MV.js` 文件末尾追加了以下实现。追加段只往 `window.MV` 上挂**原来没有的**
新名字（内部有 `if (typeof MV.xxx !== 'function')` 保护，绝不覆盖既有 API）：

| API（**本项目追加**） | 返回值 | 说明 |
|---|---|---|
| `vec2(x, y)` | `Array(2)` | 二维向量；也支持 `vec2([x, y])`；缺省分量 0 |
| `multScalar(a, b)` | 数组 | 向量逐分量乘标量，**两种参数顺序都支持**：`multScalar(2, [1,2,3])` 与 `multScalar([1,2,3], 2)` 都返回 `[2,4,6]` |
| `mat4Inverse(m)` | `Array(16)` | 4×4 求逆（`inverse` 的别名，语义更明确；参数必须是长度 16，防误传 3×3） |
| `mat3Inverse(m)` | `Array(9)` | 3×3 求逆（只接受长度 9） |
| `mat3Transpose(m)` | `Array(9)` | 3×3 转置（只接受长度 9） |
| `lerp(a, b, t)` | 数组 | 向量线性插值 `a + (b-a)·t`，用于动画 / 过渡 |
| `clamp(x, lo, hi)` | number | 标量钳制到 `[lo, hi]`，用于参数范围保护 |

> 标记约定：只有本节表格里的函数是「本项目追加」的，其余全部是教材原版函数。
> `src/` 里若用到这些函数，期末讲解时说明「原版 MV.js 没有，是本项目补的」即可。

### 1.9 使用示例

```js
const { MV } = window;

// 模型矩阵：先缩放 → 再绕 Y 轴旋转 → 再平移
let model = MV.scale(0.5, 0.5, 0.5);
model = MV.rotate(model, 30, [0, 1, 0]);
model = MV.translate(model, 0, 1, 0);

// 上传给着色器
gl.uniformMatrix4fv(gl.getUniformLocation(program, 'uModel'), false, MV.flatten(model));
gl.uniformMatrix3fv(gl.getUniformLocation(program, 'uNormalMatrix'), false,
                    MV.flatten(MV.normalMatrix(model)));

// 视图 / 投影
const view = MV.lookAt([0, 3, 8], [0, 1, 0], [0, 1, 0]);
const proj = MV.perspective(55, canvas.width / canvas.height, 0.1, 100);
```

---

## 2. `webgl-utils.js` —— 上下文与画布尺寸

| API | 说明 |
|---|---|
| `WebGLUtils.setupWebGL(canvasOrId, options?)` | 创建 **WebGL 2.0**（`webgl2`）上下文并返回；`canvasOrId` 可以是 `<canvas>` 元素或元素 id。内部按「原属性 → 关抗锯齿 → 最低要求」三轮降级重试，全部失败时抛出带排查建议的中文 `Error`（不会返回 null） |
| `WebGLUtils.resizeCanvasToDisplaySize(canvasOrId, gl)` | 按 CSS 尺寸 × `devicePixelRatio`（**上限 2**）设置 `canvas.width/height`；尺寸变化时返回 `true` 并顺带调用 `gl.viewport(0,0,w,h)`，未变化返回 `false` |
| `WebGLUtils.getContext(canvasOrId, options?)` | 只取当前画布的 `webgl2` 上下文（拿不到返回 `null`，不抛错） |

默认上下文属性：`alpha:false, depth:true, stencil:false, antialias:true, premultipliedAlpha:true,
preserveDrawingBuffer:false, powerPreference:'high-performance'`；`options` 可覆盖任意属性。
**本项目只创建 `webgl2` 上下文**（着色器使用 `#version 300 es`）。

---

## 3. `initShaders.js` —— 着色器编译 / 链接

| API | 说明 |
|---|---|
| `initShaders.createShader(gl, type, source)` | 创建并编译一个 shader；`source` 可以是 GLSL 源码字符串、`<script id="...">` 的 id（如 `'vs'` / `'#vs'`）或 `<script>` 元素本身 |
| `initShaders.createProgram(gl, vsSource, fsSource)` | 编译两个 shader 并链接成 program（失败时清理所有对象）；`vsSource` / `fsSource` 同样支持字符串 / id / 元素 |

编译或链接失败时抛出 `Error`，消息里包含 WebGL 的 info log **和带行号的源码**，
便于直接定位 GLSL 第几行出错。

---

## 4. Node 单元测试（零第三方依赖）

```bash
node tools/test-mv.mjs
```

测试用 `node:vm` 建沙箱、伪造 `window` / `document`，像浏览器一样依次执行三个经典脚本，
再对 MV 的矩阵 / 向量函数、`initShaders` / `WebGLUtils`（mock 的 WebGL 对象）逐项断言；
同时验证「经典脚本没有污染其它全局名」以及第 1.8 节的**追加 API**。

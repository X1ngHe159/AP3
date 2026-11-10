/**
 * src/shaders.js —— 全部 GLSL ES 3.00 着色器源码（手写 Phong / 阴影 / 纹理 / 环境贴图 / 拾取 / 描边）
 * ------------------------------------------------------------------
 * 教材对应关系：
 *   Phong 模型（环境 + 漫反射 + 镜面）      —— Ch6.4 – Ch6.6
 *   纹理映射（attribute → varying 插值 → texture 采样） —— Ch7.1 – Ch7.3
 *   环境贴图反射 reflection mapping           —— Ch7.6（教材 7.6 节）
 *   阴影贴图（两遍渲染）                      —— Ch8.8
 *   Blinn–Phong / Toon 变体（选做 E3）        —— Ch6 课后扩展
 *
 * 顶点属性固定槽位（与 gl-utils.js 的 ATTRIB 一致）：
 *   location 0 = position, 1 = normal, 2 = texCoord(uv), 3 = tangent
 */

/* ================================================================== */
/*  主着色器：Phong + 纹理 + 法线贴图 + 环境反射 + 阴影                    */
/* ================================================================== */

export const MAIN_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aTexCoord;
layout(location = 3) in vec3 aTangent;

uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProj;
uniform mat3 uNormalMatrix;
uniform mat4 uLightVP;   // 方向光的光源视图投影矩阵（世界 → 光源裁剪空间）

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out vec3 vTangent;
out vec4 vLightSpacePos;

void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(uNormalMatrix * aNormal);
  vTangent = normalize(mat3(uModel) * aTangent);
  vUv = aTexCoord;
  vLightSpacePos = uLightVP * world;
  gl_Position = uProj * uView * world;
}
`;

export const MAIN_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp samplerCube;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in vec3 vTangent;
in vec4 vLightSpacePos;

out vec4 fragColor;

/* ---- 相机 ---- */
uniform vec3 uCameraPos;

/* ---- 环境光 + 方向光（太阳） ---- */
uniform vec3 uAmbientLight;      // 环境光颜色（已乘强度）
uniform bool uDirEnabled;
uniform vec3 uDirDirection;      // 单位向量：从表面指向光源
uniform vec3 uDirColor;          // 方向光颜色（已乘强度）

/* ---- 点光源 0 / 1（点光，带距离衰减） ---- */
uniform bool uPoint0Enabled;
uniform vec3 uPoint0Pos;
uniform vec3 uPoint0Color;
uniform bool uPoint1Enabled;
uniform vec3 uPoint1Pos;
uniform vec3 uPoint1Color;

/* ---- 材质（Phong 三分量参数，全部以 uniform 暴露，面板实时调节） ---- */
uniform float uAmbientStrength;  // k_a 环境光强度
uniform vec3 uDiffuseColor;      // k_d 漫反射颜色
uniform float uSpecularStrength; // k_s 镜面强度
uniform vec3 uSpecularColor;     // 高光颜色
uniform float uShininess;        // n 高光指数
uniform vec3 uEmissive;          // 自发光
uniform float uOpacity;

/* ---- 三分量独立开关 + 全局倍率 ---- */
uniform bool uAmbientOn;
uniform bool uDiffuseOn;
uniform bool uSpecularOn;
uniform float uAmbientScale;
uniform float uDiffuseScale;
uniform float uSpecularScale;

/* ---- 位图纹理（Ch7.1：uTexScale 控制平铺次数） ---- */
uniform bool uHasTexture;
uniform sampler2D uTexture;
uniform vec2 uUvScale;
uniform bool uTexModulate;

/* ---- 法线贴图（选做 E1） ---- */
uniform bool uHasNormalMap;
uniform sampler2D uNormalMap;
uniform float uNormalStrength;

/* ---- 立方体环境贴图反射（Ch7.6） ---- */
uniform bool uHasReflect;
uniform samplerCube uEnvMap;
uniform float uReflectStrength;

/* ---- 方向光阴影贴图（Ch8.8 第二遍） ---- */
uniform bool uShadowEnabled;
uniform sampler2D uShadowMap;
uniform float uShadowBias;
uniform bool uShadowPcf;
uniform float uShadowSoftness;
uniform vec2 uShadowTexel;

/* ---- 点光源立方体阴影（选做 E2） ---- */
uniform bool uPointShadowEnabled;
uniform samplerCube uPointShadowMap;
uniform vec3 uPointShadowPos;
uniform float uPointShadowFar;
uniform float uPointShadowBias;

/* ---- 拾取高亮（选中物体：变色 + 边缘光） ---- */
uniform bool uSelected;
uniform vec3 uSelectedColor;

/* ---- 着色模型：0 = Phong, 1 = Blinn-Phong, 2 = Toon ---- */
uniform int uShadingModel;

/* ---- 调试可视化：0 = 正常, 1 = 输出方向光阴影因子, 2 = 输出光源空间 UV ---- */
uniform int uDebugMode;

/* ================================================================== */
/*  法线：若有法线贴图，用 T/B/N 切线空间重建世界空间法线                  */
/* ================================================================== */
vec3 surfaceNormal() {
  vec3 N = normalize(vNormal);
  if (uHasNormalMap) {
    vec3 T = normalize(vTangent - N * dot(N, vTangent));
    vec3 B = cross(N, T);
    vec3 tn = texture(uNormalMap, vUv * uUvScale).xyz * 2.0 - 1.0;
    tn.xy *= uNormalStrength;
    return normalize(T * tn.x + B * tn.y + N * tn.z);
  }
  return N;
}

/* ================================================================== */
/*  方向光阴影：把片元投影到光源裁剪空间，与第一遍写入的深度比较            */
/* ================================================================== */
float directionalShadow(vec3 N, vec3 L) {
  if (!uShadowEnabled) return 1.0;
  vec3 proj = vLightSpacePos.xyz / vLightSpacePos.w;   // 透视除法 → NDC
  proj = proj * 0.5 + 0.5;                             // → [0,1] 纹理坐标
  if (proj.z > 1.0 || proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0) return 1.0;

  // 斜率偏移：表面越"斜"（N·L 越小）需要的偏移越大，治阴影粉刺（自遮挡条纹）
  float bias = max(uShadowBias * (1.0 - dot(N, L)), uShadowBias * 0.25);
  float current = proj.z - bias;

  if (uShadowPcf) {
    float shadow = 0.0;
    vec2 step = uShadowTexel * uShadowSoftness;
    for (int x = -1; x <= 1; x++) {
      for (int y = -1; y <= 1; y++) {
        float d = texture(uShadowMap, proj.xy + vec2(float(x), float(y)) * step).r;
        shadow += (current > d) ? 0.0 : 1.0;
      }
    }
    return shadow / 9.0;
  }
  float d = texture(uShadowMap, proj.xy).r;
  return (current > d) ? 0.0 : 1.0;
}

/* ================================================================== */
/*  点光源阴影：立方体深度图里存的是透视深度，先线性化再和实际距离比较        */
/* ================================================================== */
float pointShadow() {
  if (!uPointShadowEnabled) return 1.0;
  vec3 toFrag = vWorldPos - uPointShadowPos;
  float dist = length(toFrag);
  if (dist > uPointShadowFar) return 1.0;
  float stored = texture(uPointShadowMap, normalize(toFrag)).r;
  // 透视深度 [0,1] → 线性距离（near = 0.05，far = uPointShadowFar）
  float n = 0.05;
  float z = stored * 2.0 - 1.0;
  float linearDepth = (2.0 * n * uPointShadowFar) / (uPointShadowFar + n - z * (uPointShadowFar - n));
  float bias = max(uPointShadowBias * (1.0 + dist * 0.15), uPointShadowBias);
  return (dist - bias > linearDepth) ? 0.0 : 1.0;
}

/* ================================================================== */
/*  单个光源的 Phong 贡献（漫反射 + 镜面，按开关与着色模型分支）             */
/* ================================================================== */
vec3 lightContribution(vec3 N, vec3 V, vec3 albedo, vec3 L, vec3 lightColor, float shadowFactor) {
  if (lightColor.r + lightColor.g + lightColor.b <= 0.0 || shadowFactor <= 0.0) {
    // 完全处在阴影里的片元只保留环境光（环境光在外面统一加）
    if (shadowFactor <= 0.0) return vec3(0.0);
  }
  float ndl = max(dot(N, L), 0.0);
  vec3 result = vec3(0.0);

  /* -------- 漫反射项：k_d · max(N·L, 0) · I_light -------- */
  if (uDiffuseOn) {
    float diffuseTerm = ndl;
    if (uShadingModel == 2) {                    // Toon：把 N·L 量化成 3 级色带
      diffuseTerm = ndl <= 0.0 ? 0.0 : (floor(ndl * 3.0) + 1.0) / 3.0;
    }
    result += uDiffuseScale * albedo * diffuseTerm * lightColor * shadowFactor;
  }

  /* -------- 镜面项：k_s · max(R·V,0)^n（Phong）或 max(N·H,0)^n（Blinn） -------- */
  if (uSpecularOn && ndl > 0.0) {
    float spec;
    if (uShadingModel == 1) {
      vec3 H = normalize(L + V);                  // Blinn–Phong 半程向量
      spec = pow(max(dot(N, H), 0.0), uShininess);
    } else {
      vec3 R = reflect(-L, N);                    // Phong 反射向量
      spec = pow(max(dot(R, V), 0.0), uShininess);
    }
    if (uShadingModel == 2) spec = step(0.55, spec);   // Toon：高光硬边
    result += uSpecularScale * uSpecularStrength * uSpecularColor * spec * lightColor * shadowFactor;
  }
  return result;
}

void main() {
  vec3 N = surfaceNormal();
  vec3 V = normalize(uCameraPos - vWorldPos);

  /* -------- 1. 漫反射颜色（k_d）：有纹理就乘上采样结果 -------- */
  vec3 albedo = uDiffuseColor;
  if (uHasTexture) {
    vec3 texColor = texture(uTexture, vUv * uUvScale).rgb;
    albedo = uTexModulate ? (albedo * texColor) : texColor;
  }

  /* -------- 2. 环境光项：k_a · I_ambient · albedo（不受法线/阴影影响） -------- */
  vec3 color = vec3(0.0);
  if (uAmbientOn) {
    color += uAmbientScale * uAmbientStrength * uAmbientLight * albedo;
  }

  /* -------- 3. 方向光（太阳），带阴影贴图查找 -------- */
  float dirShadow = 1.0;
  if (uDirEnabled) {
    vec3 L = normalize(uDirDirection);
    dirShadow = directionalShadow(N, L);
    color += lightContribution(N, V, albedo, L, uDirColor, dirShadow);
  }

  /* -------- 调试可视化（0 = 正常；1 = 阴影因子；2 = 光源空间 UV） -------- */
  if (uDebugMode == 1) {
    // 白 = 被照亮，黑 = 处在阴影里。用于验证阴影贴图是否真的在起作用
    fragColor = vec4(vec3(dirShadow), 1.0);
    return;
  }
  if (uDebugMode == 2) {
    vec2 lightUv = (vLightSpacePos.xy / vLightSpacePos.w) * 0.5 + 0.5;
    fragColor = vec4(lightUv, 0.0, 1.0);
    return;
  }
  if (uDebugMode == 3) {
    // 阴影贴图在该片元光源空间位置上的深度（白 = 贴图里没有东西）
    vec2 lightUv = (vLightSpacePos.xy / vLightSpacePos.w) * 0.5 + 0.5;
    float stored = texture(uShadowMap, lightUv).r;
    fragColor = vec4(vec3(stored), 1.0);
    return;
  }
  if (uDebugMode == 4) {
    // 该片元自己的光源空间深度（与模式 3 对比即可判断遮挡关系）
    float own = (vLightSpacePos.z / vLightSpacePos.w) * 0.5 + 0.5;
    fragColor = vec4(vec3(own), 1.0);
    return;
  }
  if (uDebugMode == 5) {
    // 点光源立方体阴影的阴影因子（白 = 受光，黑 = 在点光阴影里）
    fragColor = vec4(vec3(pointShadow()), 1.0);
    return;
  }

  /* -------- 4. 两个点光源（距离衰减），可选点光立方体阴影（E2） -------- */
  if (uPoint0Enabled) {
    vec3 toL = uPoint0Pos - vWorldPos;
    float dist = length(toL);
    float atten = 1.0 / (1.0 + 0.16 * dist + 0.10 * dist * dist);
    float ps = uPointShadowEnabled ? pointShadow() : 1.0;
    color += lightContribution(N, V, albedo, toL / max(dist, 1e-4), uPoint0Color * atten, ps);
  }
  if (uPoint1Enabled) {
    vec3 toL = uPoint1Pos - vWorldPos;
    float dist = length(toL);
    float atten = 1.0 / (1.0 + 0.16 * dist + 0.10 * dist * dist);
    color += lightContribution(N, V, albedo, toL / max(dist, 1e-4), uPoint1Color * atten, 1.0);
  }

  /* -------- 5. 自发光（灯罩） -------- */
  color += uEmissive;

  /* -------- 6. 立方体环境贴图反射：R = reflect(I, N)，用菲涅耳加权混合 -------- */
  if (uHasReflect && uReflectStrength > 0.0001) {
    vec3 I = normalize(vWorldPos - uCameraPos);
    vec3 R = reflect(I, N);
    vec3 env = texture(uEnvMap, R).rgb;
    float fresnel = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
    float mixAmount = clamp(uReflectStrength * (0.60 + 0.40 * fresnel), 0.0, 1.0);
    color = mix(color, env, mixAmount);
  }

  /* -------- 7. 选中高亮：整体轻微变色 + 边缘光（配合描边 Pass） -------- */
  if (uSelected) {
    float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.0);
    color += uSelectedColor * (0.16 + 0.55 * rim);
  }

  /* -------- 8. 输出（限制在 [0,1] 防过曝） -------- */
  color = max(color, vec3(0.0));
  fragColor = vec4(color, uOpacity);
}
`;

/** 主程序需要一次性取 location 的 uniform 名单 */
export const MAIN_UNIFORMS = [
  'uModel', 'uView', 'uProj', 'uNormalMatrix', 'uLightVP',
  'uCameraPos', 'uAmbientLight',
  'uDirEnabled', 'uDirDirection', 'uDirColor',
  'uPoint0Enabled', 'uPoint0Pos', 'uPoint0Color',
  'uPoint1Enabled', 'uPoint1Pos', 'uPoint1Color',
  'uAmbientStrength', 'uDiffuseColor', 'uSpecularStrength', 'uSpecularColor',
  'uShininess', 'uEmissive', 'uOpacity',
  'uAmbientOn', 'uDiffuseOn', 'uSpecularOn',
  'uAmbientScale', 'uDiffuseScale', 'uSpecularScale',
  'uHasTexture', 'uTexture', 'uUvScale', 'uTexModulate',
  'uHasNormalMap', 'uNormalMap', 'uNormalStrength',
  'uHasReflect', 'uEnvMap', 'uReflectStrength',
  'uShadowEnabled', 'uShadowMap', 'uShadowBias', 'uShadowPcf', 'uShadowSoftness', 'uShadowTexel',
  'uPointShadowEnabled', 'uPointShadowMap', 'uPointShadowPos', 'uPointShadowFar', 'uPointShadowBias',
  'uSelected', 'uSelectedColor', 'uShadingModel', 'uDebugMode'
];

/* ================================================================== */
/*  简单着色器：顶点变换（阴影 Pass / 拾取 Pass 共用）                      */
/* ================================================================== */

export const SIMPLE_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
uniform mat4 uModel;
uniform mat4 uViewProj;   // 或 = uProj * uView
void main() {
  gl_Position = uViewProj * uModel * vec4(aPosition, 1.0);
}
`;

/** 深度 Pass：不写颜色，只让硬件把深度写进深度纹理 */
export const DEPTH_FS = `#version 300 es
precision highp float;
void main() {
}
`;

/** 拾取 Pass：每个物体用唯一 ID 颜色平涂（颜色编码拾取） */
export const PICK_FS = `#version 300 es
precision highp float;
uniform vec3 uPickColor;   // id 编码成 RGB（r + g*256 + b*65536）
out vec4 fragColor;
void main() {
  fragColor = vec4(uPickColor, 1.0);
}
`;

/* ================================================================== */
/*  天空盒：全屏三角形 + 逆视图投影矩阵反算每个像素的世界方向              */
/* ================================================================== */

export const FULLSCREEN_VS = `#version 300 es
layout(location = 0) in vec2 aPosition;
out vec2 vNdc;
void main() {
  vNdc = aPosition;
  gl_Position = vec4(aPosition, 1.0, 1.0);   // z = 1：贴在远平面，永远在物体后面
}
`;

export const SKYBOX_FS = `#version 300 es
precision highp float;
precision highp samplerCube;

in vec2 vNdc;
out vec4 fragColor;

uniform mat4 uInvViewProj;   // inverse(uProj * uView)
uniform vec3 uCameraPos;
uniform samplerCube uSky;
uniform float uExposure;

void main() {
  // 取近、远裁剪面上的两点，相减得到该像素的视线方向（透视/正交投影都成立）
  vec4 farPoint = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec4 nearPoint = uInvViewProj * vec4(vNdc, -1.0, 1.0);
  vec3 dir = normalize(farPoint.xyz / farPoint.w - nearPoint.xyz / nearPoint.w);
  vec3 col = texture(uSky, dir).rgb * uExposure;
  fragColor = vec4(col, 1.0);
}
`;

/* ================================================================== */
/*  全屏显示一张纹理：深度图小窗 / 拾取 ID 调试显示                        */
/* ================================================================== */

export const FULLSCREEN_TEX_FS = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vNdc;
out vec4 fragColor;

uniform sampler2D uTex;
uniform int uMode;   // 0 = 深度可视化, 1 = 原样输出颜色

void main() {
  vec2 uv = vNdc * 0.5 + 0.5;
  vec4 c = texture(uTex, uv);
  if (uMode == 0) {
    // 深度值一般集中在 0.9 附近，放大差异后便于观察锯齿 / 漏光
    float d = clamp(c.r, 0.0, 1.0);
    fragColor = vec4(vec3(pow(d, 24.0)), 1.0);
  } else {
    fragColor = vec4(c.rgb, 1.0);
  }
}
`;

/* ================================================================== */
/*  点光阴影调试：把立方体深度图的某一个面显示出来                          */
/* ================================================================== */

export const CUBE_DEPTH_FS = `#version 300 es
precision highp float;
precision highp samplerCube;

in vec2 vNdc;
out vec4 fragColor;

uniform samplerCube uCubeDepth;

void main() {
  // 用 -Z 方向近似还原立方体贴图的一个面，仅用于调参时观察深度分布
  vec3 dir = normalize(vec3(vNdc.x, vNdc.y, -1.0));
  float d = texture(uCubeDepth, dir).r;
  fragColor = vec4(vec3(pow(clamp(d, 0.0, 1.0), 24.0)), 1.0);
}
`;

/* ================================================================== */
/*  选中描边：沿法线外扩 + 剔除正面，只在轮廓外露出一圈颜色                */
/* ================================================================== */

export const OUTLINE_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform float uOutlineWidth;
void main() {
  vec3 expanded = aPosition + aNormal * uOutlineWidth;
  gl_Position = uViewProj * uModel * vec4(expanded, 1.0);
}
`;

export const OUTLINE_FS = `#version 300 es
precision highp float;
uniform vec3 uOutlineColor;
out vec4 fragColor;
void main() {
  fragColor = vec4(uOutlineColor, 1.0);
}
`;

/* ================================================================== */
/*  纯色绘制：光源辅助显示（点光小球 / 方向光箭头）                        */
/* ================================================================== */

export const FLAT_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
uniform mat4 uModel;
uniform mat4 uViewProj;
void main() {
  gl_Position = uViewProj * uModel * vec4(aPosition, 1.0);
}
`;

export const FLAT_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 fragColor;
void main() {
  fragColor = vec4(uColor, 1.0);
}
`;

/* ================================================================== */
/*  线框模式：复用主 VS + 纯色 FS（用 gl.LINES 画三角形边）                */
/* ================================================================== */

export const WIRE_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 fragColor;
void main() {
  fragColor = vec4(uColor, 1.0);
}
`;

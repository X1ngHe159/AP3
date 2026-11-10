/**
 * src/renderer.js —— 渲染器：把 Pass 顺序、uniform、状态串起来
 * ------------------------------------------------------------------
 * 每一帧的 Pass 顺序（README 里有图 docs/diagrams/pipeline-overview.png）：
 *   Pass 1  阴影（第一遍）：光源视角写深度到 FBO                src/shadow.js
 *   Pass 2  天空盒：全屏三角形 + 逆视图投影反算方向，采样立方体贴图
 *   Pass 3  不透明物体：手写 Phong（环境 + 漫反射 + 镜面）+ 纹理 + 法线贴图
 *           + 立方体环境贴图反射 + 阴影纹理比较
 *   Pass 4  选中描边：沿法线外扩、剔除正面
 *   Pass 5  透明物体：blend 混合（玻璃球，选做 E2）
 *   Pass 6  调试/显示：光源辅助、阴影贴图小窗、拾取 ID 调试、三联分屏对比（E3）
 *
 * 所有"参数"都从 src/state.js 的 state 读取，面板改一个滑块下一帧就能看到效果。
 */

import {
  createProgram, uniformLocations, createFullscreenTriangle, resizeCanvas
} from './gl-utils.js';
import * as SH from './shaders.js';
import { state } from './state.js';
import { cameraMatrices } from './camera.js';
import { createScene, lightsForState, shadowCameraForState, POINT_SHADOW_FAR } from './scene.js';
import { createShadows } from './shadow.js';
import { createPicker } from './picking.js';
import { loadTextures, textureToggleEnabled } from './textures.js';
import { identity, composeTRS } from './mat.js';

/** 选中物体的高亮颜色（青） */
const SELECT_COLOR = new Float32Array([0.30, 0.86, 1.0]);

/** state.shading 字符串 → 着色器里的整数分支 */
const SHADING_INDEX = { phong: 0, blinn: 1, toon: 2 };

/**
 * 创建渲染器（异步：需要先加载纹理/立方体贴图）。
 * @returns 渲染器对象，含 renderFrame / pickAt / screenshot / scene / assets
 */
export async function createRenderer(gl, canvas, { onProgress = () => {} } = {}) {
  /* ---------------- 1. 着色器程序 ---------------- */
  onProgress(0.02, '编译着色器…');
  const mainProgram = createProgram(gl, SH.MAIN_VS, SH.MAIN_FS, 'main-phong');
  const mainLocs = uniformLocations(gl, mainProgram, SH.MAIN_UNIFORMS);

  const skyProgram = createProgram(gl, SH.FULLSCREEN_VS, SH.SKYBOX_FS, 'skybox');
  const skyLocs = uniformLocations(gl, skyProgram, ['uInvViewProj', 'uCameraPos', 'uSky', 'uExposure']);

  const quadProgram = createProgram(gl, SH.FULLSCREEN_VS, SH.FULLSCREEN_TEX_FS, 'fullscreen-tex');
  const quadLocs = uniformLocations(gl, quadProgram, ['uTex', 'uMode']);

  const cubeQuadProgram = createProgram(gl, SH.FULLSCREEN_VS, SH.CUBE_DEPTH_FS, 'cube-depth-quad');
  const cubeQuadLocs = uniformLocations(gl, cubeQuadProgram, ['uCubeDepth']);

  const outlineProgram = createProgram(gl, SH.OUTLINE_VS, SH.OUTLINE_FS, 'outline');
  const outlineLocs = uniformLocations(gl, outlineProgram, ['uModel', 'uViewProj', 'uOutlineWidth', 'uOutlineColor']);

  const flatProgram = createProgram(gl, SH.SIMPLE_VS, SH.FLAT_FS, 'flat');
  const flatLocs = uniformLocations(gl, flatProgram, ['uModel', 'uViewProj', 'uColor']);

  /* ---------------- 2. 场景 / 阴影 / 拾取 / 资源 ---------------- */
  const scene = createScene(gl);
  const shadows = createShadows(gl);
  const picker = createPicker(gl);
  const fullscreen = createFullscreenTriangle(gl);

  const assets = await loadTextures(gl, (p, msg) => onProgress(0.15 + p * 0.8, msg));

  /* ---------------- 3. 固定不变的 sampler 绑定 ---------------- */
  gl.useProgram(mainProgram);
  gl.uniform1i(mainLocs.uTexture, 0);
  gl.uniform1i(mainLocs.uNormalMap, 1);
  gl.uniform1i(mainLocs.uEnvMap, 2);
  gl.uniform1i(mainLocs.uShadowMap, 3);
  gl.uniform1i(mainLocs.uPointShadowMap, 4);

  /* ---------------- 4. 每帧的临时数据 ---------------- */
  let lastCam = null;          // 供拾取使用的相机矩阵
  let drawCalls = 0;
  const IDENTITY = identity();

  /* ================================================================ */
  /*  天空盒                                                           */
  /* ================================================================ */
  function drawSkybox(cam) {
    if (!state.textures.skybox || !assets.cubemap) return;
    gl.useProgram(skyProgram);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, assets.cubemap);
    gl.uniform1i(skyLocs.uSky, 0);
    gl.uniformMatrix4fv(skyLocs.uInvViewProj, false, cam.invViewProj);
    gl.uniform3fv(skyLocs.uCameraPos, cam.eye);
    gl.uniform1f(skyLocs.uExposure, 1.0);
    gl.bindVertexArray(fullscreen.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
  }

  /* ================================================================ */
  /*  主 Pass 的公共 uniform                                            */
  /* ================================================================ */
  function beginMainPass(cam, lights, lightCam, shadowTarget, shadingOverride) {
    gl.useProgram(mainProgram);
    const L = mainLocs;

    gl.uniformMatrix4fv(L.uView, false, cam.view);
    gl.uniformMatrix4fv(L.uProj, false, cam.proj);
    gl.uniformMatrix4fv(L.uLightVP, false, lightCam ? lightCam.viewProj : IDENTITY);
    gl.uniform3fv(L.uCameraPos, cam.eye);

    /* ---- 光源 ---- */
    gl.uniform3fv(L.uAmbientLight, new Float32Array(lights.ambient));
    gl.uniform1i(L.uDirEnabled, state.lights.dir.enabled ? 1 : 0);
    gl.uniform3fv(L.uDirDirection, lights.dirDirection);
    gl.uniform3fv(L.uDirColor, new Float32Array(lights.dirColor));
    gl.uniform1i(L.uPoint0Enabled, state.lights.point1.enabled ? 1 : 0);
    gl.uniform3fv(L.uPoint0Pos, lights.point0);
    gl.uniform3fv(L.uPoint0Color, new Float32Array(lights.point0Color));
    gl.uniform1i(L.uPoint1Enabled, state.lights.point2.enabled ? 1 : 0);
    gl.uniform3fv(L.uPoint1Pos, lights.point1);
    gl.uniform3fv(L.uPoint1Color, new Float32Array(lights.point1Color));

    /* ---- Phong 三分量开关 / 倍率 ---- */
    gl.uniform1i(L.uAmbientOn, state.phong.ambient ? 1 : 0);
    gl.uniform1i(L.uDiffuseOn, state.phong.diffuse ? 1 : 0);
    gl.uniform1i(L.uSpecularOn, state.phong.specular ? 1 : 0);
    gl.uniform1f(L.uAmbientScale, state.phong.ambientScale);
    gl.uniform1f(L.uDiffuseScale, state.phong.diffuseScale);
    gl.uniform1f(L.uSpecularScale, state.phong.specularScale);

    /* ---- 方向光阴影 ---- */
    const dirShadow = !!(state.shadow.enabled && state.shadow.mode === 'dir' && shadowTarget);
    gl.uniform1i(L.uShadowEnabled, dirShadow ? 1 : 0);
    if (dirShadow) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, shadowTarget.texture);
      gl.uniform1i(L.uShadowMap, 3);
      gl.uniform1f(L.uShadowBias, state.shadow.bias);
      gl.uniform1i(L.uShadowPcf, state.shadow.pcf ? 1 : 0);
      gl.uniform1f(L.uShadowSoftness, state.shadow.softness);
      gl.uniform2f(L.uShadowTexel, 1.0 / shadowTarget.size, 1.0 / shadowTarget.size);
    }

    /* ---- 点光源立方体阴影（E2） ---- */
    const pointShadow = !!(state.shadow.enabled && state.shadow.mode === 'point' && shadowTarget);
    gl.uniform1i(L.uPointShadowEnabled, pointShadow ? 1 : 0);
    if (pointShadow) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, shadowTarget.texture);
      gl.uniform1i(L.uPointShadowMap, 4);
      gl.uniform3fv(L.uPointShadowPos, lights.point0);
      gl.uniform1f(L.uPointShadowFar, POINT_SHADOW_FAR);
      gl.uniform1f(L.uPointShadowBias, Math.max(0.03, state.shadow.bias * 10.0));
    }

    gl.uniform3fv(L.uSelectedColor, SELECT_COLOR);
    const shading = shadingOverride != null ? shadingOverride : (SHADING_INDEX[state.shading] || 0);
    gl.uniform1i(L.uShadingModel, shading);
    // 调试可视化：0 正常 / 1 阴影因子 / 2 光源空间 UV（诊断阴影贴图用）
    gl.uniform1i(L.uDebugMode, state.display.debugMode | 0);
  }

  /* ================================================================ */
  /*  单个物体的材质 uniform + 绘制                                     */
  /* ================================================================ */
  function drawItem(item, { forceNormalMap = null } = {}) {
    const L = mainLocs;
    const mat = state.materials[item.id];
    if (!mat) return;

    gl.uniformMatrix4fv(L.uModel, false, item.model);
    gl.uniformMatrix3fv(L.uNormalMatrix, false, item.normalMatrix);

    /* ---- 材质参数（面板实时调节的就是这些 uniform） ---- */
    gl.uniform1f(L.uAmbientStrength, mat.ambientStrength);
    gl.uniform3fv(L.uDiffuseColor, new Float32Array(mat.diffuseColor));
    gl.uniform1f(L.uSpecularStrength, mat.specularStrength);
    gl.uniform3fv(L.uSpecularColor, new Float32Array(mat.specularColor));
    gl.uniform1f(L.uShininess, Math.max(1.0, mat.shininess));
    gl.uniform3fv(L.uEmissive, new Float32Array(mat.emissive));
    gl.uniform1f(L.uOpacity, mat.opacity);
    gl.uniform2fv(L.uUvScale, new Float32Array(mat.uvScale));

    /* ---- 位图纹理 ---- */
    let useTexture = false;
    if (mat.texture && assets.textures[mat.texture] && textureToggleEnabled(state, mat.texture)) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, assets.textures[mat.texture]);
      useTexture = true;
    }
    gl.uniform1i(L.uHasTexture, useTexture ? 1 : 0);
    gl.uniform1i(L.uTexModulate, state.textures.modulate ? 1 : 0);

    /* ---- 法线贴图（选做 E1，可分屏对比强制开关） ---- */
    const wantNormalMap = forceNormalMap !== null ? forceNormalMap : state.textures.normalMap;
    let useNormalMap = false;
    if (wantNormalMap && mat.normalTexture && assets.textures[mat.normalTexture] &&
        textureToggleEnabled(state, mat.normalTexture)) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, assets.textures[mat.normalTexture]);
      useNormalMap = true;
    }
    gl.uniform1i(L.uHasNormalMap, useNormalMap ? 1 : 0);
    gl.uniform1f(L.uNormalStrength, state.textures.normalStrength);

    /* ---- 立方体环境贴图反射 ---- */
    const useEnv = !!(state.textures.cubemap && mat.reflect > 0.0001 && assets.cubemap);
    gl.uniform1i(L.uHasReflect, useEnv ? 1 : 0);
    gl.uniform1f(L.uReflectStrength, useEnv ? mat.reflect * state.textures.reflectionStrength : 0.0);
    if (useEnv) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, assets.cubemap);
    }

    /* ---- 选中高亮 ---- */
    gl.uniform1i(L.uSelected, item.id === state.selectedId ? 1 : 0);

    gl.bindVertexArray(item.mesh.vao);
    gl.drawElements(gl.TRIANGLES, item.mesh.indexCount, item.mesh.indexType, 0);
    gl.bindVertexArray(null);
    drawCalls += 1;
  }

  /* ================================================================ */
  /*  线框模式（用去重边索引 + gl.LINES 画）                             */
  /* ================================================================ */
  function drawWireframe(cam) {
    gl.useProgram(flatProgram);
    gl.uniformMatrix4fv(flatLocs.uViewProj, false, cam.viewProj);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    for (const item of scene.items) {
      const mat = state.materials[item.id];
      gl.uniformMatrix4fv(flatLocs.uModel, false, item.model);
      gl.uniform3f(flatLocs.uColor, mat.diffuseColor[0], mat.diffuseColor[1], mat.diffuseColor[2]);
      gl.bindVertexArray(item.mesh.lineVao);
      gl.drawElements(gl.LINES, item.mesh.lineIndexCount, item.mesh.indexType, 0);
      drawCalls += 1;
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
  }

  /* ================================================================ */
  /*  选中描边（Pass 4）                                                */
  /* ================================================================ */
  function drawSelectionOutline(cam) {
    if (!state.selectedId) return;
    const item = scene.items.find((it) => it.id === state.selectedId);
    if (!item) return;
    // 半透明物体不画外扩描边：它不写深度，外扩网格的背面会铺满整个球面。
    // 这类物体改用片元着色器里的"边缘光 + 变色"高亮（uSelected 分支）。
    const selectedMaterial = state.materials[item.id];
    if (selectedMaterial && selectedMaterial.opacity < 0.995) return;
    gl.useProgram(outlineProgram);
    gl.uniformMatrix4fv(outlineLocs.uViewProj, false, cam.viewProj);
    gl.uniformMatrix4fv(outlineLocs.uModel, false, item.model);
    // 外扩宽度按物体大小自适应，避免大物体描边过粗 / 小物体看不见
    gl.uniform1f(outlineLocs.uOutlineWidth, Math.max(0.012, item.radius * 0.022));
    gl.uniform3fv(outlineLocs.uOutlineColor, SELECT_COLOR);
    gl.cullFace(gl.FRONT);        // 只保留外扩网格的背面 → 轮廓外圈
    gl.depthMask(false);
    gl.bindVertexArray(item.mesh.vao);
    gl.drawElements(gl.TRIANGLES, item.mesh.indexCount, item.mesh.indexType, 0);
    gl.bindVertexArray(null);
    gl.cullFace(gl.BACK);
    gl.depthMask(true);
    drawCalls += 1;
  }

  /* ================================================================ */
  /*  光源辅助显示                                                      */
  /* ================================================================ */
  function drawLightHelpers(cam, lights) {
    if (!state.display.lightHelpers) return;
    gl.useProgram(flatProgram);
    gl.uniformMatrix4fv(flatLocs.uViewProj, false, cam.viewProj);
    const mesh = scene.helperMesh;
    gl.bindVertexArray(mesh.vao);

    const drawBall = (pos, color) => {
      const model = composeTRS([pos[0], pos[1], pos[2]], [0, 0, 0], [1, 1, 1]);
      gl.uniformMatrix4fv(flatLocs.uModel, false, model);
      gl.uniform3f(flatLocs.uColor, color[0], color[1], color[2]);
      gl.drawElements(gl.TRIANGLES, mesh.indexCount, mesh.indexType, 0);
      drawCalls += 1;
    };

    // 两个点光源：用它们自己的颜色画一个小球
    if (state.lights.point1.enabled) drawBall(lights.point0, state.lights.point1.color);
    if (state.lights.point2.enabled) drawBall(lights.point1, state.lights.point2.color);
    // 方向光（太阳）：在方向向量上放一个更大的亮球
    if (state.lights.dir.enabled) {
      const d = lights.dirDirection;
      const sunPos = [d[0] * 9.0, Math.max(3.2, d[1] * 9.0), d[2] * 9.0];
      drawBall(sunPos, [1.0, 0.95, 0.75]);
    }
    gl.bindVertexArray(null);
  }

  /* ================================================================ */
  /*  透明物体 Pass（E2：blend 混合，由远到近画）                        */
  /* ================================================================ */
  function drawTransparent(cam, items) {
    if (!items.length) return;
    const eye = cam.eye;
    const sorted = items.slice().sort((a, b) => {
      const da = (a.position[0] - eye[0]) ** 2 + (a.position[1] - eye[1]) ** 2 + (a.position[2] - eye[2]) ** 2;
      const db = (b.position[0] - eye[0]) ** 2 + (b.position[1] - eye[1]) ** 2 + (b.position[2] - eye[2]) ** 2;
      return db - da;                 // 远的先画
    });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);              // 透明物体不写深度，避免挡住后面的物体
    for (const item of sorted) drawItem(item);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /* ================================================================ */
  /*  一次完整的场景 Pass（用于普通渲染 / 分屏的每个视口）                 */
  /* ================================================================ */
  function renderScenePass(cam, lights, lightCam, shadowTarget, viewport, opts = {}) {
    gl.viewport(viewport.x, viewport.y, viewport.w, viewport.h);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    drawSkybox(cam);

    if (state.display.wireframe) {
      drawWireframe(cam);
      return;
    }

    beginMainPass(cam, lights, lightCam, shadowTarget, opts.shadingOverride);

    const opaque = [];
    const transparent = [];
    for (const item of scene.items) {
      const mat = state.materials[item.id];
      if (!mat) continue;
      if (mat.opacity < 0.995) transparent.push(item);
      else opaque.push(item);
    }

    for (const item of opaque) drawItem(item, { forceNormalMap: opts.forceNormalMap });
    drawSelectionOutline(cam);
    drawLightHelpers(cam, lights);
    drawTransparent(cam, transparent);
  }
  /* ================================================================ */
  /*  调试显示：阴影贴图小窗 / 拾取 ID 图                                */
  /* ================================================================ */
  function drawShadowDebugWindow(w, h, shadowTarget) {
    const size = Math.min(260, Math.floor(Math.min(w, h) / 3));
    gl.viewport(w - size - 18, 18, size, size);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    if (state.shadow.mode === 'dir' && shadowTarget) {
      gl.useProgram(quadProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, shadowTarget.texture);
      gl.uniform1i(quadLocs.uTex, 0);
      gl.uniform1i(quadLocs.uMode, 0);
    } else if (state.shadow.mode === 'point' && shadowTarget) {
      gl.useProgram(cubeQuadProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, shadowTarget.texture);
      gl.uniform1i(cubeQuadLocs.uCubeDepth, 0);
    } else {
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      return;
    }
    gl.bindVertexArray(fullscreen.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }

  function drawPickDebug(w, h, cam) {
    picker.renderIds(scene.items, cam.viewProj, w, h);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(quadProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, picker.getTexture());
    gl.uniform1i(quadLocs.uTex, 0);
    gl.uniform1i(quadLocs.uMode, 1);
    gl.bindVertexArray(fullscreen.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }

  /* ================================================================ */
  /*  渲染一帧                                                          */
  /* ================================================================ */
  function renderFrame() {
    resizeCanvas(gl, canvas);
    const w = canvas.width;
    const h = canvas.height;
    const aspect = w / Math.max(1, h);
    drawCalls = 0;

    const cam = cameraMatrices(state.camera, aspect);
    lastCam = cam;
    const lights = lightsForState(state);

    /* ---- Pass 1：阴影 ---- */
    let shadowTarget = null;
    let lightCam = null;
    if (state.shadow.enabled) {
      if (state.shadow.mode === 'dir') {
        lightCam = shadowCameraForState(state);
        shadowTarget = shadows.renderDirectional(scene.items, lightCam.viewProj, state.shadow.resolution);
      } else {
        shadowTarget = shadows.renderPoint(scene.items, lights.point0, state.shadow.resolution);
      }
    }

    /* ---- 默认帧缓冲：清屏 ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.055, 0.07, 0.09, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const fullViewport = { x: 0, y: 0, w, h };

    if (state.compare.split) {
      /* ---- 选做 E3：Phong / Blinn-Phong / Toon 三联分屏 ---- */
      const colW = Math.floor(w / 3);
      const splitAspect = colW / Math.max(1, h);
      for (let i = 0; i < 3; i++) {
        const camI = cameraMatrices(state.camera, splitAspect);
        renderScenePass(camI, lights, lightCam, shadowTarget,
          { x: i * colW, y: 0, w: colW, h },
          { shadingOverride: i });
      }
    } else if (state.compare.normal) {
      /* ---- 选做 E1：法线贴图左右对比 ---- */
      const halfW = Math.floor(w / 2);
      const halfAspect = halfW / Math.max(1, h);
      const camL = cameraMatrices(state.camera, halfAspect);
      renderScenePass(camL, lights, lightCam, shadowTarget,
        { x: 0, y: 0, w: halfW, h }, { forceNormalMap: false });
      renderScenePass(camL, lights, lightCam, shadowTarget,
        { x: halfW, y: 0, w: halfW, h }, { forceNormalMap: true });
    } else {
      renderScenePass(cam, lights, lightCam, shadowTarget, fullViewport, {});
    }

    /* ---- 调试显示（覆盖在正常画面上） ---- */
    if (state.shadow.showMap && state.shadow.enabled) {
      drawShadowDebugWindow(w, h, shadowTarget);
    }
    if (state.display.pickDebug) {
      drawPickDebug(w, h, cam);
    }

    /* ---- 恢复默认状态，供下一帧使用 ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    state.stats.tris = scene.totalTriangles;
    state.stats.drawCalls = drawCalls;
    return { cam, w, h };
  }

  /* ================================================================ */
  /*  拾取                                                              */
  /* ================================================================ */

  /**
   * 屏幕坐标（CSS 像素，原点左上角）→ 拾取物体。
   * @returns {object|null} 命中的 scene item
   */
  function pickAtCss(xCss, yCss) {
    if (!lastCam) return null;
    const scaleX = canvas.width / Math.max(1, canvas.clientWidth);
    const scaleY = canvas.height / Math.max(1, canvas.clientHeight);
    return picker.pickAt(scene.items, lastCam.viewProj,
      xCss * scaleX, yCss * scaleY, canvas.width, canvas.height);
  }

  /** 当前画布截图（PNG data URL），"保存截图"按钮用 */
  function screenshot() {
    return canvas.toDataURL('image/png');
  }

  return {
    scene,
    assets,
    shadows,
    picker,
    renderFrame,
    pickAtCss,
    screenshot,
    gl,
    /** 方向光阴影相机的 view/proj（自测与调试用） */
    getShadowCamera: () => shadowCameraForState(state),
    /** 调试用：主 Phong program 与其 uniform 位置（tools/diagnose-*.mjs） */
    __mainProgramForDebug: { program: mainProgram, locs: mainLocs },
    get lastCam() { return lastCam; }
  };
}

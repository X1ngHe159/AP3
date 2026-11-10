/**
 * src/shadow.js —— 阴影贴图系统（教材 Ch8.8 两遍渲染的第一遍）
 * ------------------------------------------------------------------
 * 方向光阴影（必做）：
 *   1) 建 2048² 的 DEPTH_COMPONENT24 深度纹理 + FBO；
 *   2) 把相机放到光源位置、用正交投影覆盖整个庭院，渲染所有投射阴影的物体，
 *      这一遍只写深度（片元着色器为空，深度由硬件写入）；
 *   3) 主 Pass 里同一个深度纹理被采样，片元自己的光源空间深度 > 贴图深度 → 处于阴影。
 * 点光源阴影（选做 E2）：
 *   用立方体深度纹理（90° × 6 个面），主 Pass 里按"从光源指向片元"的方向采样
 *   对应面，得到线性化后的距离再比较。
 */

import { createProgram, uniformLocations, createShadowFBO, createPointShadowFBO } from './gl-utils.js';
import { SIMPLE_VS, DEPTH_FS } from './shaders.js';
import { perspective, multiply } from './mat.js';
import { pointShadowViews, POINT_SHADOW_NEAR, POINT_SHADOW_FAR } from './scene.js';

/** 点光阴影立方体的边长上限（6 面 × 1024² 已经足够，再大会拖慢帧率） */
const MAX_POINT_SIZE = 1024;

/**
 * 创建阴影系统。
 * @returns 带 ensureDirFBO / ensurePointFBO / renderDirectional / renderPoint 的对象
 */
export function createShadows(gl) {
  const depthProgram = createProgram(gl, SIMPLE_VS, DEPTH_FS, 'shadow-depth');
  const locs = uniformLocations(gl, depthProgram, ['uModel', 'uViewProj']);

  const cache = {
    dir: null,   // { framebuffer, texture, size }
    point: null
  };

  /** 按需（重新）创建方向光深度 FBO */
  function ensureDirFBO(size) {
    if (cache.dir && cache.dir.size === size) return cache.dir;
    if (cache.dir) {
      gl.deleteFramebuffer(cache.dir.framebuffer);
      gl.deleteTexture(cache.dir.texture);
    }
    cache.dir = createShadowFBO(gl, size);
    return cache.dir;
  }

  /** 按需（重新）创建点光立方体深度 FBO */
  function ensurePointFBO(size) {
    const clamped = Math.min(size, MAX_POINT_SIZE);
    if (cache.point && cache.point.size === clamped) return cache.point;
    if (cache.point) {
      gl.deleteFramebuffer(cache.point.framebuffer);
      gl.deleteTexture(cache.point.texture);
    }
    cache.point = createPointShadowFBO(gl, clamped);
    return cache.point;
  }

  /** 第一遍的公共绘制：把所有投射阴影的物体按光源视角画一遍（只写深度） */
  function drawCasters(items) {
    for (const item of items) {
      if (!item.castShadow) continue;
      gl.uniformMatrix4fv(locs.uModel, false, item.model);
      gl.bindVertexArray(item.mesh.vao);
      gl.drawElements(gl.TRIANGLES, item.mesh.indexCount, item.mesh.indexType, 0);
    }
    gl.bindVertexArray(null);
  }

  /**
   * 方向光阴影 Pass。
   * @param {Array} items 场景物体
   * @param {Float32Array} lightViewProj 光源视图投影矩阵（世界 → 光源裁剪空间）
   * @param {number} size 深度贴图边长
   * @returns {{framebuffer, texture, size}}
   */
  function renderDirectional(items, lightViewProj, size) {
    const target = ensureDirFBO(size);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.size, target.size);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    gl.useProgram(depthProgram);
    gl.uniformMatrix4fv(locs.uViewProj, false, lightViewProj);
    drawCasters(items);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return target;
  }

  /**
   * 点光阴影 Pass：立方体深度纹理的 6 个面各渲染一次。
   * @param {Array} items 场景物体
   * @param {Float32Array} lightPos 点光源世界坐标
   * @param {number} size 每面边长
   * @returns {{framebuffer, texture, size}}
   */
  function renderPoint(items, lightPos, size) {
    const target = ensurePointFBO(size);
    const proj = perspective(90.0, 1.0, POINT_SHADOW_NEAR, POINT_SHADOW_FAR);
    const views = pointShadowViews(lightPos);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.size, target.size);
    gl.useProgram(depthProgram);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE); // 立方体阴影对薄物体（墙）更稳

    for (let face = 0; face < 6; face++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, target.texture, 0);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const viewProj = multiply(proj, views[face].view);
      gl.uniformMatrix4fv(locs.uViewProj, false, viewProj);
      drawCasters(items);
    }

    gl.enable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return target;
  }

  return {
    depthProgram,
    locs,
    ensureDirFBO,
    ensurePointFBO,
    renderDirectional,
    renderPoint,
    get dirFBO() { return cache.dir; },
    get pointFBO() { return cache.point; }
  };
}

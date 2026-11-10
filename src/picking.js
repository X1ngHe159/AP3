/**
 * src/picking.js —— 颜色编码拾取（教材 Ch3.9 拾取思想的 GPU 版）
 * ------------------------------------------------------------------
 * 原理：
 *   1) 把整个场景重画一遍到一个离屏 FBO，每个物体不再画真实材质，
 *      而是画成"自己的唯一 ID 颜色"：id = r + g·256 + b·65536；
 *   2) 鼠标点击时用 gl.readPixels 读回那一个像素；
 *   3) 反解出 id → 找到对应物体 → 高亮 + 面板切换为该物体的材质。
 * 优点：不需要在 CPU 端做射线求交，点击哪个物体都精确到像素。
 */

import { createProgram, uniformLocations, createColorFBO, encodePickColor, decodePickColor } from './gl-utils.js';
import { SIMPLE_VS, PICK_FS } from './shaders.js';

export function createPicker(gl) {
  const program = createProgram(gl, SIMPLE_VS, PICK_FS, 'pick');
  const locs = uniformLocations(gl, program, ['uModel', 'uViewProj', 'uPickColor']);

  let fbo = null;

  function ensureFBO(width, height) {
    if (fbo && fbo.width === width && fbo.height === height) return fbo;
    if (fbo) {
      gl.deleteFramebuffer(fbo.framebuffer);
      gl.deleteTexture(fbo.texture);
      gl.deleteRenderbuffer(fbo.depthBuffer);
    }
    fbo = createColorFBO(gl, width, height);
    return fbo;
  }

  /**
   * 渲染"ID 颜色"图。
   * @returns {{framebuffer, texture, width, height}}
   */
  function renderIds(items, viewProj, width, height) {
    const target = ensureFBO(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(0, 0, 0, 1);          // id = 0 表示"什么都没点到"
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    gl.useProgram(program);
    gl.uniformMatrix4fv(locs.uViewProj, false, viewProj);
    for (const item of items) {
      const color = encodePickColor(item.pickId);
      gl.uniform3f(locs.uPickColor, color[0], color[1], color[2]);
      gl.uniformMatrix4fv(locs.uModel, false, item.model);
      gl.bindVertexArray(item.mesh.vao);
      gl.drawElements(gl.TRIANGLES, item.mesh.indexCount, item.mesh.indexType, 0);
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0.055, 0.07, 0.09, 1.0);
    return target;
  }

  /**
   * 在画布的 (x, y)（**设备像素**，原点左上角）处拾取一个物体。
   * @returns {object|null} 命中的 scene item
   */
  function pickAt(items, viewProj, x, y, width, height) {
    renderIds(items, viewProj, width, height);
    const px = new Uint8Array(4);
    // readPixels 的原点在左下角，所以要翻转 y；再夹紧到画布范围内
    const rx = Math.max(0, Math.min(width - 1, Math.floor(x)));
    const ry = Math.max(0, Math.min(height - 1, Math.floor(height - y)));
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.framebuffer);
    gl.readPixels(rx, ry, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const id = decodePickColor(px);
    if (!id) return null;
    return items.find((item) => item.pickId === id) || null;
  }

  /** 拾取调试显示用：最近一次 ID 图的纹理 */
  function getTexture() {
    return fbo ? fbo.texture : null;
  }

  return { program, locs, renderIds, pickAt, getTexture };
}

/**
 * src/textures.js —— 位图纹理 + 立方体环境贴图的加载
 * ------------------------------------------------------------------
 * 数据流：Image → gl.texImage2D → WebGLTexture → 片元着色器 texture(uTexture, vUv)
 * 关键点（README 里也有说明）：
 *   1) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true) 把图片的"左上角原点"翻成
 *      WebGL 纹理"左下角原点"，这样 v=0 对应图片底部；本项目几何体的 UV 约定与此一致；
 *   2) 场景地面/墙面需要平铺 → gl.REPEAT + mipmap（LINEAR_MIPMAP_LINEAR）；
 *   3) 立方体贴图 6 个面顺序必须是 +X,-X,+Y,-Y,+Z,-Z。
 */

import { TEXTURE_FILES, TEXTURE_DIR, CUBEMAP_FACES, CUBEMAP_DIR } from './config.js';
import { loadImage, createTexture2D, createCubemap } from './gl-utils.js';

/** 生成一张 2×2 的纯色/棋盘兜底纹理（资源缺失时项目仍可运行） */
function solidTexture(gl, rgba) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const data = new Uint8Array([
    rgba[0], rgba[1], rgba[2], 255, rgba[0], rgba[1], rgba[2], 255,
    rgba[0], rgba[1], rgba[2], 255, rgba[0], rgba[1], rgba[2], 255
  ]);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return tex;
}

/** 平法线兜底（(0,0,1) 编码成 (128,128,255)） */
function flatNormalTexture(gl) {
  return solidTexture(gl, [128, 128, 255]);
}

/** 兜底立方体贴图：六个面统一深蓝灰，保证反射球不是黑球 */
function fallbackCubemap(gl) {
  const size = 8;
  const faces = [];
  const colors = [
    [40, 52, 70], [52, 44, 58], [70, 82, 100], [26, 30, 38], [56, 48, 62], [44, 50, 66]
  ];
  for (let f = 0; f < 6; f++) {
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      data[i * 4] = colors[f][0];
      data[i * 4 + 1] = colors[f][1];
      data[i * 4 + 2] = colors[f][2];
      data[i * 4 + 3] = 255;
    }
    faces.push({ data, size });
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
  const targets = [
    gl.TEXTURE_CUBE_MAP_POSITIVE_X, gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Y, gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Z, gl.TEXTURE_CUBE_MAP_NEGATIVE_Z
  ];
  for (let i = 0; i < 6; i++) {
    gl.texImage2D(targets[i], 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, faces[i].data);
  }
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * 加载全部纹理。
 * @returns {Promise<{textures: Object, cubemap: WebGLTexture|null, missing: string[], warnings: string[]}>}
 */
export async function loadTextures(gl, onProgress = () => {}) {
  const textures = {};
  const missing = [];
  const warnings = [];
  const names = Object.keys(TEXTURE_FILES);
  let done = 0;

  for (const name of names) {
    const file = TEXTURE_FILES[name];
    try {
      const image = await loadImage(TEXTURE_DIR + file);
      textures[name] = createTexture2D(gl, image, { flipY: true, repeat: true });
    } catch (err) {
      missing.push(file);
      warnings.push(`纹理 ${file} 加载失败，使用兜底颜色（${err.message}）`);
      textures[name] = name.includes('normal') ? flatNormalTexture(gl) : solidTexture(gl, [180, 172, 160]);
    }
    done += 1;
    onProgress(done / (names.length + 1), `纹理 ${file}`);
  }

  // 立方体环境贴图（6 面同时加载）
  let cubemap = null;
  try {
    const images = await Promise.all(CUBEMAP_FACES.map((face) => loadImage(CUBEMAP_DIR + face)));
    cubemap = createCubemap(gl, images);
  } catch (err) {
    missing.push(...CUBEMAP_FACES);
    warnings.push(`立方体环境贴图加载失败，使用纯色兜底（${err.message}）`);
    cubemap = fallbackCubemap(gl);
  }
  onProgress(1, '环境贴图');

  return { textures, cubemap, missing, warnings };
}

/** 材质里的纹理名 → 是否被面板开关关闭（不在表里的纹理永远开启） */
export function textureToggleEnabled(state, textureName) {
  if (textureName === 'floor_wood' || textureName === 'floor_wood_normal') return state.textures.floor;
  if (textureName === 'crate_wood' || textureName === 'crate_wood_normal') return state.textures.crate;
  if (textureName === 'wall_plaster') return state.textures.wall;
  return true;
}

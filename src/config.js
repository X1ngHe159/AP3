/**
 * src/config.js —— 场景的「集中配置」
 * ------------------------------------------------------------------
 * 所有物体（几何体、变换、材质默认值）、光源、纹理映射关系都集中在这一个文件里，
 * 想调整场景（换物体位置、换材质、加物体）只改这里，渲染器 / UI / 拾取都自动适配。
 *
 * 坐标系约定：
 *   y 轴向上；地面在 y = 0；庭院 14×14，后墙 z ≈ -7，左墙 x ≈ -7，正面朝 +z 敞开。
 *
 * 材质字段（与 Phong 片元着色器的 uniform 一一对应）：
 *   ambientStrength  环境光系数 k_a（标量，面板"环境光强度"）
 *   diffuseColor     漫反射颜色 k_d（vec3，面板"漫反射颜色"）
 *   specularStrength 镜面系数 k_s（标量，面板"镜面强度"）
 *   specularColor    高光颜色（vec3）
 *   shininess        高光指数 n（越大高光越锐利）
 *   opacity          不透明度（< 1 时进入透明 Pass，选做 E2）
 *   emissive         自发光颜色（灯罩用，不受光照影响）
 *   reflect          立方体环境贴图反射混合系数（0 = 不反射，1 = 全反射）
 *   texture          位图纹理文件名（assets/textures/ 下，不含扩展名），null = 不用
 *   normalTexture    切线空间法线贴图（选做 E1），null = 不用
 *   uvScale          UV 重复次数 [u, v]，用来让贴图在物体表面按合适密度平铺
 */

/** 材质默认值：所有物体共用同一套字段，缺省项在这里补全 */
export const MATERIAL_DEFAULTS = {
  ambientStrength: 0.10,
  diffuseColor: [0.72, 0.66, 0.58],
  specularStrength: 0.25,
  specularColor: [1.0, 1.0, 1.0],
  shininess: 32.0,
  opacity: 1.0,
  emissive: [0.0, 0.0, 0.0],
  reflect: 0.0,
  texture: null,
  normalTexture: null,
  uvScale: [1.0, 1.0]
};

/**
 * 物体表。每一项：
 *   id           唯一标识（拾取编码、材质表 key 都用它）
 *   name         中文名（HUD / 面板显示）
 *   geometry     { type, args }：type 对应 src/geometry.js 的导出函数，args 是参数数组
 *   transform    平移 / 欧拉角旋转（度）/ 缩放；模型矩阵 = T · Rz · Ry · Rx · S
 *   material     材质（会与 MATERIAL_DEFAULTS 合并）
 *   castShadow   是否投射阴影（阴影 Pass 的光源视角深度写入）
 *   receiveShadow 是否接收阴影（主 Pass 里做深度比较）
 *   pickable     是否参与拾取（墙上大面积物体也可拾取，便于演示）
 */
export const OBJECTS = [
  {
    id: 'floor',
    name: '木地板',
    geometry: { type: 'box', args: [14.0, 0.4, 14.0] },
    transform: { position: [0.0, -0.2, 0.0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.14,
      diffuseColor: [0.95, 0.86, 0.74],
      specularStrength: 0.10,
      shininess: 18,
      texture: 'floor_wood',
      normalTexture: 'floor_wood_normal',
      uvScale: [4.0, 4.0]
    },
    castShadow: false,
    receiveShadow: true
  },
  {
    id: 'backWall',
    name: '后墙',
    geometry: { type: 'box', args: [14.0, 3.2, 0.35] },
    transform: { position: [0.0, 1.6, -7.0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.10,
      diffuseColor: [0.96, 0.93, 0.88],
      specularStrength: 0.05,
      shininess: 6,
      texture: 'wall_plaster',
      uvScale: [3.0, 1.6]
    },
    castShadow: true,
    receiveShadow: true
  },
  {
    id: 'leftWall',
    name: '左墙',
    geometry: { type: 'box', args: [0.35, 3.2, 14.0] },
    transform: { position: [-7.0, 1.6, 0.0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.10,
      diffuseColor: [0.96, 0.93, 0.88],
      specularStrength: 0.05,
      shininess: 6,
      texture: 'wall_plaster',
      uvScale: [3.0, 1.6]
    },
    castShadow: true,
    receiveShadow: true
  },
  {
    id: 'crate',
    name: '板条箱',
    geometry: { type: 'box', args: [1.15, 1.15, 1.15] },
    transform: { position: [1.95, 0.575, -1.15], rotation: [0, 18, 0], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.09,
      diffuseColor: [1.0, 0.94, 0.86],
      specularStrength: 0.18,
      shininess: 24,
      texture: 'crate_wood',
      normalTexture: 'crate_wood_normal',
      uvScale: [1.0, 1.0]
    },
    castShadow: true,
    receiveShadow: true
  },
  {
    id: 'crateTop',
    name: '小木箱',
    geometry: { type: 'box', args: [0.72, 0.72, 0.72] },
    transform: { position: [2.05, 1.51, -1.02], rotation: [0, -26, 0], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.09,
      diffuseColor: [0.98, 0.92, 0.84],
      specularStrength: 0.16,
      shininess: 20,
      texture: 'crate_wood',
      uvScale: [1.0, 1.0]
    },
    castShadow: true,
    receiveShadow: true
  },
  {
    id: 'pedestal',
    name: '大理石台座',
    geometry: { type: 'cylinder', args: [0.50, 0.85, 48] },
    transform: { position: [-2.40, 0.425, -1.40], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.12,
      diffuseColor: [0.97, 0.96, 0.93],
      specularStrength: 0.35,
      shininess: 72,
      texture: 'marble',
      uvScale: [2.0, 1.0]
    },
    castShadow: true,
    receiveShadow: true
  },
  {
    id: 'mirrorSphere',
    name: '反射球（环境贴图）',
    geometry: { type: 'sphere', args: [0.52, 32, 64] },
    transform: { position: [-2.40, 1.375, -1.40], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.06,
      diffuseColor: [0.12, 0.15, 0.20],
      specularStrength: 1.0,
      shininess: 220,
      reflect: 1.0,
      uvScale: [1.0, 1.0]
    },
    castShadow: true,
    receiveShadow: true
  },
  {
    id: 'goldTorus',
    name: '金环',
    geometry: { type: 'torus', args: [0.44, 0.14, 64, 32] },
    transform: { position: [0.15, 0.58, 1.15], rotation: [90, 0, 12], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.08,
      diffuseColor: [0.86, 0.62, 0.24],
      specularStrength: 1.0,
      specularColor: [1.0, 0.94, 0.72],
      shininess: 150,
      reflect: 0.25,
      uvScale: [1.0, 1.0]
    },
    castShadow: true,
    receiveShadow: true
  },
  {
    id: 'tileCube',
    name: 'UV 棋盘方块',
    geometry: { type: 'box', args: [0.70, 0.70, 0.70] },
    transform: { position: [3.55, 0.35, 1.30], rotation: [0, 32, 0], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.10,
      diffuseColor: [0.90, 0.90, 0.90],
      specularStrength: 0.22,
      shininess: 40,
      texture: 'tile_checker',
      uvScale: [1.0, 1.0]
    },
    castShadow: true,
    receiveShadow: true
  },
  {
    id: 'ceramicSphere',
    name: '陶瓷球',
    geometry: { type: 'sphere', args: [0.30, 24, 48] },
    transform: { position: [3.10, 0.30, -2.55], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.10,
      diffuseColor: [0.86, 0.32, 0.26],
      specularStrength: 0.70,
      shininess: 96,
      reflect: 0.10,
      uvScale: [1.0, 1.0]
    },
    castShadow: true,
    receiveShadow: true
  },
  {
    id: 'barrel',
    name: '木桶',
    geometry: { type: 'cylinder', args: [0.36, 0.98, 40] },
    transform: { position: [2.75, 0.49, -3.05], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.09,
      diffuseColor: [0.95, 0.90, 0.84],
      specularStrength: 0.16,
      shininess: 26,
      texture: 'crate_wood',
      uvScale: [2.0, 1.0]
    },
    castShadow: true,
    receiveShadow: true
  },
  {
    id: 'glassSphere',
    name: '玻璃球（透明混合 E2）',
    geometry: { type: 'sphere', args: [0.45, 28, 56] },
    transform: { position: [-1.15, 0.45, 1.85], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.05,
      diffuseColor: [0.62, 0.86, 0.95],
      specularStrength: 1.0,
      shininess: 300,
      opacity: 0.30,
      reflect: 0.55,
      uvScale: [1.0, 1.0]
    },
    castShadow: false,
    receiveShadow: true
  },
  {
    id: 'lampPost',
    name: '灯柱',
    geometry: { type: 'cylinder', args: [0.06, 2.10, 24] },
    transform: { position: [1.69, 1.05, 0.75], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.08,
      diffuseColor: [0.26, 0.24, 0.21],
      specularStrength: 0.45,
      shininess: 70,
      reflect: 0.05,
      uvScale: [1.0, 1.0]
    },
    castShadow: true,
    receiveShadow: true
  },
  {
    id: 'lampShade',
    name: '灯罩（点光 1 所在地）',
    geometry: { type: 'cone', args: [0.42, 0.50, 40] },
    transform: { position: [1.69, 2.10, 0.75], rotation: [180, 0, 0], scale: [1, 1, 1] },
    material: {
      ambientStrength: 0.30,
      diffuseColor: [1.0, 0.82, 0.55],
      specularStrength: 0.30,
      shininess: 40,
      emissive: [0.95, 0.55, 0.22],
      uvScale: [1.0, 1.0]
    },
    castShadow: true,
    receiveShadow: false
  }
];

/** 把 OBJECTS 的材质与默认值合并，得到完整材质表（state.materials 的初值） */
export function buildMaterials() {
  const materials = {};
  for (const obj of OBJECTS) {
    const m = { ...MATERIAL_DEFAULTS, ...obj.material };
    m.diffuseColor = [...m.diffuseColor];
    m.specularColor = [...m.specularColor];
    m.emissive = [...m.emissive];
    m.uvScale = [...m.uvScale];
    materials[obj.id] = m;
  }
  return materials;
}

/** 纹理文件名 → 相对路径（场景里只写逻辑名，路径集中在这里） */
export const TEXTURE_DIR = 'assets/textures/';
export const CUBEMAP_DIR = 'assets/cubemap/';

/** 纹理逻辑名 → 实际文件 */
export const TEXTURE_FILES = {
  floor_wood: 'floor_wood.png',
  floor_wood_normal: 'floor_wood_normal.png',
  crate_wood: 'crate_wood.png',
  crate_wood_normal: 'crate_wood_normal.png',
  wall_plaster: 'wall_plaster.png',
  tile_checker: 'tile_checker.png',
  marble: 'marble.png'
};

/** 立方体环境贴图六面（顺序：+X, -X, +Y, -Y, +Z, -Z，符合 gl.TEXTURE_CUBE_MAP_* 约定） */
export const CUBEMAP_FACES = ['px.png', 'nx.png', 'py.png', 'ny.png', 'pz.png', 'nz.png'];

/** 光源辅助可视化的尺寸（点光源小球 + 方向光箭头长度） */
export const LIGHT_HELPER = { pointRadius: 0.075, dirArrowLength: 2.2 };

/** 每个物体在拾取 Pass 中的唯一颜色编码 id（从 1 开始，0 表示背景） */
export const PICK_ID_OFFSET = 1;

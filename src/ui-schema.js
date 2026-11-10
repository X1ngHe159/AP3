/**
 * src/ui-schema.js —— 参数面板的「数据化定义」
 * ------------------------------------------------------------------
 * 面板上的每一个控件都只是这里的一个普通对象（声明式），
 * src/ui.js 读它自动生成 DOM 并双向绑定到 src/state.js，
 * 所以「加一个参数」只需要：state.js 加字段 + 这里加一行。
 *
 * 控件类型（ui.js 必须支持）：
 *   range    : path 写回 Number；显示 format(value) + unit
 *   checkbox : path 写回 Boolean
 *   select   : path 写回 option.value；numeric:true 时转 Number
 *   color    : path 写回 [r,g,b]（0..1 浮点数组）；显示用 #rrggbb
 *   button   : 点击回调 onAction(action)，不改 state
 *   info     : 只读文本，sync 时调用 text(state) 刷新
 *
 * path 里的 `*` 表示「当前选中物体」的 id（例如 'materials.*.shininess'）。
 */
export const PANEL_SCHEMA = {
  groups: [
    /* ================================================================ */
    {
      id: 'camera',
      title: '相机与投影',
      items: [
        {
          type: 'select', id: 'sel-projection', label: '投影方式', path: 'camera.projection',
          options: [{ value: 'perspective', label: '透视投影 (O)' }, { value: 'orthographic', label: '正交投影 (O)' }]
        },
        {
          type: 'range', id: 'rng-fov', label: '视场角 FOV', path: 'camera.fov',
          min: 25, max: 100, step: 1, unit: '°', format: (v) => v.toFixed(0)
        },
        {
          type: 'range', id: 'rng-distance', label: '观察距离', path: 'camera.distance',
          min: 2.5, max: 18, step: 0.1, unit: '', format: (v) => v.toFixed(1)
        },
        { type: 'checkbox', id: 'chk-autorotate', label: '自动环绕（空格暂停）', path: 'camera.autoRotate' },
        { type: 'button', id: 'btn-reset-camera', label: '重置视角 (R)', action: 'resetCamera' }
      ]
    },

    /* ================================================================ */
    {
      id: 'lights',
      title: '光源',
      hint: '1 个方向光（太阳）+ 2 个点光 + 环境光；方向光负责阴影，点光提供近场暖/冷补光。',
      items: [
        { type: 'info', id: 'info-lights', label: '光源数量', text: (s) => {
          let n = 0;
          if (s.lights.dir.enabled) n += 1;
          if (s.lights.point1.enabled) n += 1;
          if (s.lights.point2.enabled) n += 1;
          return `${n} 个（方向光 ${s.lights.dir.enabled ? '开' : '关'}）`;
        } },
        {
          type: 'range', id: 'rng-ambient', label: '环境光强度', path: 'lights.ambient.intensity',
          min: 0, max: 0.8, step: 0.01, unit: '', format: (v) => v.toFixed(2)
        },
        { type: 'checkbox', id: 'chk-dirlight', label: '方向光（太阳，L 键）', path: 'lights.dir.enabled' },
        {
          type: 'range', id: 'rng-dir-intensity', label: '方向光强度', path: 'lights.dir.intensity',
          min: 0, max: 2.2, step: 0.02, unit: '', format: (v) => v.toFixed(2)
        },
        {
          type: 'range', id: 'rng-dir-azimuth', label: '太阳方位角', path: 'lights.dir.azimuth',
          min: -180, max: 180, step: 1, unit: '°', format: (v) => v.toFixed(0)
        },
        {
          type: 'range', id: 'rng-dir-elevation', label: '太阳仰角', path: 'lights.dir.elevation',
          min: 8, max: 89, step: 1, unit: '°', format: (v) => v.toFixed(0)
        },
        { type: 'checkbox', id: 'chk-point1', label: '点光 1（暖色，P 键）', path: 'lights.point1.enabled' },
        {
          type: 'range', id: 'rng-point1-intensity', label: '点光 1 强度', path: 'lights.point1.intensity',
          min: 0, max: 3, step: 0.02, unit: '', format: (v) => v.toFixed(2)
        },
        {
          type: 'range', id: 'rng-point1-height', label: '点光 1 高度', path: 'lights.point1.height',
          min: 0.3, max: 3.2, step: 0.02, unit: 'm', format: (v) => v.toFixed(2)
        },
        {
          type: 'range', id: 'rng-point1-radius', label: '点光 1 半径', path: 'lights.point1.radius',
          min: 0.4, max: 4.5, step: 0.05, unit: 'm', format: (v) => v.toFixed(2)
        },
        {
          type: 'range', id: 'rng-point1-angle', label: '点光 1 方位', path: 'lights.point1.angle',
          min: -180, max: 180, step: 1, unit: '°', format: (v) => v.toFixed(0)
        },
        { type: 'checkbox', id: 'chk-point2', label: '点光 2（冷色补光）', path: 'lights.point2.enabled' },
        {
          type: 'range', id: 'rng-point2-intensity', label: '点光 2 强度', path: 'lights.point2.intensity',
          min: 0, max: 2, step: 0.02, unit: '', format: (v) => v.toFixed(2)
        },
        {
          type: 'range', id: 'rng-point2-x', label: '点光 2 位置 X', path: 'lights.point2.x',
          min: -5, max: 5, step: 0.05, unit: 'm', format: (v) => v.toFixed(2)
        },
        {
          type: 'range', id: 'rng-point2-z', label: '点光 2 位置 Z', path: 'lights.point2.z',
          min: -5, max: 5, step: 0.05, unit: 'm', format: (v) => v.toFixed(2)
        }
      ]
    },

    /* ================================================================ */
    {
      id: 'phong',
      title: 'Phong 三分量（全局开关）',
      hint: 'A / D / S 键快速切换；README 的四种组合对比图用这四个开关录制。',
      items: [
        { type: 'checkbox', id: 'chk-ambient-on', label: '环境光 Iₐ (A)', path: 'phong.ambient' },
        { type: 'checkbox', id: 'chk-diffuse-on', label: '漫反射 I_d (D)', path: 'phong.diffuse' },
        { type: 'checkbox', id: 'chk-specular-on', label: '镜面 I_s (S)', path: 'phong.specular' },
        {
          type: 'range', id: 'rng-ambient-scale', label: '环境分量倍率', path: 'phong.ambientScale',
          min: 0, max: 2.5, step: 0.02, unit: '×', format: (v) => v.toFixed(2)
        },
        {
          type: 'range', id: 'rng-diffuse-scale', label: '漫反射分量倍率', path: 'phong.diffuseScale',
          min: 0, max: 2.5, step: 0.02, unit: '×', format: (v) => v.toFixed(2)
        },
        {
          type: 'range', id: 'rng-specular-scale', label: '镜面分量倍率', path: 'phong.specularScale',
          min: 0, max: 2.5, step: 0.02, unit: '×', format: (v) => v.toFixed(2)
        }
      ]
    },

    /* ================================================================ */
    /*  动态分组：内容取决于当前选中物体（拾取后自动刷新）                 */
    /* ================================================================ */
    {
      id: 'material',
      title: '选中物体材质',
      dynamic: 'material',
      hint: '在画面中单击物体即可选中并切换；选中的物体会高亮（描边 + 边缘光）。',
      items: [
        { type: 'info', id: 'info-selected', label: '当前物体', text: (s) => s.selectedName },
        {
          type: 'range', id: 'rng-mat-ka', label: '环境光强度 kₐ', path: 'materials.*.ambientStrength',
          min: 0, max: 1, step: 0.01, unit: '', format: (v) => v.toFixed(2)
        },
        { type: 'color', id: 'col-mat-kd', label: '漫反射颜色 k_d', path: 'materials.*.diffuseColor' },
        {
          type: 'range', id: 'rng-mat-ks', label: '镜面强度 kₛ', path: 'materials.*.specularStrength',
          min: 0, max: 2, step: 0.01, unit: '', format: (v) => v.toFixed(2)
        },
        {
          type: 'range', id: 'rng-mat-shininess', label: '高光指数 n', path: 'materials.*.shininess',
          min: 1, max: 256, step: 1, unit: '', format: (v) => v.toFixed(0)
        },
        {
          type: 'range', id: 'rng-mat-reflect', label: '环境反射强度', path: 'materials.*.reflect',
          min: 0, max: 1, step: 0.01, unit: '', format: (v) => v.toFixed(2)
        },
        {
          type: 'range', id: 'rng-mat-opacity', label: '不透明度（E2）', path: 'materials.*.opacity',
          min: 0.05, max: 1, step: 0.01, unit: '', format: (v) => v.toFixed(2)
        },
        { type: 'button', id: 'btn-clear-selection', label: '取消选中', action: 'clearSelection' }
      ]
    },

    /* ================================================================ */
    {
      id: 'textures',
      title: '纹理与环境贴图',
      hint: '位图纹理用 gl.texImage2D 上传，采样在片元着色器里完成；法线贴图是选做 E1。',
      items: [
        { type: 'checkbox', id: 'chk-tex-floor', label: '木地板贴图', path: 'textures.floor' },
        { type: 'checkbox', id: 'chk-tex-crate', label: '板条箱贴图', path: 'textures.crate' },
        { type: 'checkbox', id: 'chk-tex-wall', label: '墙面贴图', path: 'textures.wall' },
        { type: 'checkbox', id: 'chk-tex-normal', label: '法线贴图 (N)（E1）', path: 'textures.normalMap' },
        {
          type: 'range', id: 'rng-normal-strength', label: '法线凸起强度', path: 'textures.normalStrength',
          min: 0, max: 3, step: 0.05, unit: '×', format: (v) => v.toFixed(2)
        },
        { type: 'checkbox', id: 'chk-tex-cubemap', label: '环境贴图反射 (C)', path: 'textures.cubemap' },
        {
          type: 'range', id: 'rng-reflection', label: '环境反射倍率', path: 'textures.reflectionStrength',
          min: 0, max: 1.5, step: 0.02, unit: '×', format: (v) => v.toFixed(2)
        },
        { type: 'checkbox', id: 'chk-tex-skybox', label: '天空盒', path: 'textures.skybox' },
        { type: 'checkbox', id: 'chk-tex-modulate', label: '纹理颜色调制 k_d', path: 'textures.modulate' }
      ]
    },

    /* ================================================================ */
    {
      id: 'shadow',
      title: '阴影贴图',
      hint: '第一遍光源视角写深度到 FBO，第二遍比较深度。调节 bias / 正交范围 / 分辨率可观察阴影粉刺、锯齿、漏光。',
      items: [
        { type: 'checkbox', id: 'chk-shadow-on', label: '开启阴影 (H)', path: 'shadow.enabled' },
        {
          type: 'select', id: 'sel-shadow-mode', label: '阴影光源', path: 'shadow.mode',
          options: [{ value: 'dir', label: '方向光阴影贴图' }, { value: 'point', label: '点光立方体阴影 (E2)' }]
        },
        {
          type: 'select', id: 'sel-shadow-res', label: '阴影贴图分辨率', path: 'shadow.resolution', numeric: true,
          options: [{ value: 1024, label: '1024 × 1024' }, { value: 2048, label: '2048 × 2048' }, { value: 4096, label: '4096 × 4096' }]
        },
        {
          type: 'range', id: 'rng-shadow-ortho', label: '正交视锥半宽', path: 'shadow.orthoSize',
          min: 3, max: 14, step: 0.1, unit: 'm', format: (v) => v.toFixed(1)
        },
        {
          type: 'range', id: 'rng-shadow-bias', label: '深度偏移 bias', path: 'shadow.bias',
          min: 0, max: 0.012, step: 0.0001, unit: '', format: (v) => v.toFixed(4)
        },
        { type: 'checkbox', id: 'chk-shadow-pcf', label: '3×3 PCF 软阴影', path: 'shadow.pcf' },
        {
          type: 'range', id: 'rng-shadow-softness', label: 'PCF 采样半径', path: 'shadow.softness',
          min: 0.5, max: 4, step: 0.05, unit: 'px', format: (v) => v.toFixed(2)
        },
        { type: 'checkbox', id: 'chk-shadow-debug', label: '显示深度图小窗', path: 'shadow.showMap' },
        {
          type: 'select', id: 'sel-debug-mode', label: '调试可视化（答辩演示）', path: 'display.debugMode', numeric: true,
          options: [
            { value: 0, label: '关闭（正常渲染）' },
            { value: 1, label: '方向光阴影因子' },
            { value: 2, label: '光源空间 UV' },
            { value: 3, label: '阴影贴图深度' },
            { value: 4, label: '片元自身深度' },
            { value: 5, label: '点光阴影因子' }
          ]
        }
      ]
    },

    /* ================================================================ */
    {
      id: 'shading',
      title: '着色模型与扩展',
      hint: 'E3：Blinn–Phong（半程向量 H）与 Toon（色阶化）可与原 Phong 三联并排对比。',
      items: [
        {
          type: 'select', id: 'sel-shading', label: '着色模型 (1/2/3)', path: 'shading',
          options: [
            { value: 'phong', label: '① Phong（R·V 幂）' },
            { value: 'blinn', label: '② Blinn–Phong（N·H 幂）' },
            { value: 'toon', label: '③ Toon 卡通着色' }
          ]
        },
        { type: 'checkbox', id: 'chk-compare-split', label: '三联分屏对比 (X)（E3）', path: 'compare.split' },
        { type: 'checkbox', id: 'chk-wireframe', label: '线框模式 (F)', path: 'display.wireframe' },
        { type: 'checkbox', id: 'chk-light-helpers', label: '光源辅助显示', path: 'display.lightHelpers' },
        { type: 'checkbox', id: 'chk-pick-debug', label: '显示拾取 ID 颜色', path: 'display.pickDebug' },
        { type: 'button', id: 'btn-screenshot', label: '保存当前画面截图', action: 'screenshot' },
        { type: 'button', id: 'btn-reset-all', label: '恢复全部默认参数', action: 'resetAll' }
      ]
    }
  ]
};

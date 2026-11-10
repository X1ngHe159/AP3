#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AP3「光照与纹理场景」贴图资产生成器（Pillow + numpy，纯程序化，无网络素材）。

用法：
    python tools/make_textures.py

输出：
    assets/textures/floor_wood.png          512x512 RGB  深色木地板（横向木板条）
    assets/textures/floor_wood_normal.png   512x512 RGB  对应的切线空间法线贴图（选做 E1 对比用）
    assets/textures/crate_wood.png          512x512 RGB  木箱正面（木板 + 深色边框 + 金属包角 + 铆钉）
    assets/textures/crate_wood_normal.png   512x512 RGB  对应的切线空间法线贴图
    assets/textures/wall_plaster.png        512x512 RGB  暖灰米色抹灰墙（颗粒 + 污渍 + 低频明暗）
    assets/textures/tile_checker.png        512x512 RGB  8x8 双色棋盘格 + 网格线 + 半透明 U/V 标注
    assets/textures/marble.png              512x512 RGB  浅色大理石（台座 / 圆柱）
    assets/textures/manifest.json           数组清单：file / size / usage / tileable

    assets/cubemap/{px,nx,py,ny,pz,nz}.png  1024x1024 RGB  无缝黄昏天空盒六面

生成方式（可复现）：
  1. 全部贴图由本脚本用 numpy 向量化计算 + Pillow 编码，固定主种子 MASTER_SEED = 20261018，
     所有随机数由 SHA-256(master_seed:tag) 派生，重复运行结果完全一致（幂等）。
  2. 无缝（可平铺）原理：所有噪声都用「周期值噪声」——每个倍频在 u/v 方向分别以整数
     fx/fy 个格子为周期，采样坐标 x=u*fx 后对 fx 取模回绕，因此图像左右、上下边缘
     像素严格连续；木板/边框/铆钉/网格线等结构也都用模运算构造，且所有模糊/梯度
     使用 np.roll 环绕采样，保证 u=0 与 u=1、v=0 与 v=1 都是同一条缝。
  3. 法线贴图：先从同一套结构高度场 h(u,v) 出发（板缝凹槽、铆钉凸起、木纹起伏），
     用环绕差分求梯度，再按切线空间编码：
         RGB = ( (-dh/du)*k, (+dh/dv_img)*k, 1 ) 归一化后 *0.5+0.5
     即 OpenGL/WebGL 约定：+X 向右、+Y 向上（图 v 增大方向）、+Z 朝外；
     平坦区域正好是 (128,128,255)。与 floor_wood / crate_wood 一一对应，供 E1 对比。
  4. 天空盒：对每个面的每个像素，按 WebGL / OpenGL 立方体贴图标准映射反算方向向量
     dir（+X,-X,+Y,-Y,+Z,-Z 的顺序），再用一个连续的 sky(dir) 函数求颜色；因为颜色
     只取决于方向，六个面在公共棱上取到相同方向，所以天然无缝、不会贴反。
     贴图行 0 对应 GL 的 t=0（PNG 顶部 = 天空上方），与 WebGL 默认 UNPACK_FLIP_Y=false
     的上传方式一致。

每张贴图贴在哪里：
    floor_wood            → 房间地板 / 庭院石木地面（平铺，UV 重复 6x6）
    floor_wood_normal     → 同一地板的法线贴图（E1 法线贴图开关对比）
    crate_wood            → 木箱六个面（房间角落道具、可拾取物体）
    crate_wood_normal     → 同一个木箱的法线贴图（金属包角与板条凹凸）
    wall_plaster          → 房间四壁 / 庭院围墙
    tile_checker          → UV 演示平面（README 讲 UV 数据流用的棋盘格地面/演示板）
    marble                → 中央台座 / 圆柱 / 雕塑底座

约束：全部 ≤ 500 KB/张，assets 目录 ≤ 6 MB；PNG optimize=True。
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ----------------------------------------------------------------------------
# 基础设置
# ----------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[1]
TEX_DIR = ROOT / "assets" / "textures"
CUBE_DIR = ROOT / "assets" / "cubemap"
MASTER_SEED = 20261018
F32 = np.float32

# 统一使用「图像坐标 → 周期参数」的采样网格（像素中心对齐，保证无缝）
_TEX_RECORDS: list[dict] = []
_TAB_CACHE: dict[tuple, np.ndarray] = {}
_N3_CACHE: dict[str, "Noise3"] = {}

HORIZON_SUN = np.array([-0.42, 0.115, 0.90], dtype=F32)  # 黄昏低垂的太阳方向（+Z 偏 -X）
HORIZON_SUN /= np.linalg.norm(HORIZON_SUN)


def seed32(*parts) -> int:
    """由主种子 + 标签派生确定性的 32 位随机种子。"""
    txt = ":".join([str(MASTER_SEED)] + [str(p) for p in parts])
    return int.from_bytes(hashlib.sha256(txt.encode("utf-8")).digest()[:4], "little")


# ----------------------------------------------------------------------------
# 周期值噪声（2D，严格可平铺）与 fBm
# ----------------------------------------------------------------------------
def _pnoise_table(fx: int, fy: int, seed: int) -> np.ndarray:
    key = (int(fx), int(fy), int(seed))
    tab = _TAB_CACHE.get(key)
    if tab is None:
        rng = np.random.default_rng(seed)
        tab = rng.random((int(fy), int(fx)), dtype=F32)
        _TAB_CACHE[key] = tab
    return tab


def pnoise(u, v, fx: int, fy: int, seed: int):
    """周期值噪声：以 fx×fy 个格点为一个周期，u,v 任意形状（广播）。

    采样坐标 = u*fx（u 以 1 为周期），格点索引对 fx/fy 取模回绕，
    因此 u=0 与 u=1 取到完全相同的值 —— 贴图左右无缝；v 同理。
    """
    fx = max(int(round(fx)), 1)
    fy = max(int(round(fy)), 1)
    tab = _pnoise_table(fx, fy, seed)
    x = np.asarray(u, dtype=F32) * fx
    y = np.asarray(v, dtype=F32) * fy
    xi = np.floor(x)
    yi = np.floor(y)
    tx = x - xi
    ty = y - yi
    # 五次平滑（C2 连续，避免网格状走样）
    tx = tx * tx * tx * (tx * (tx * F32(6.0) - F32(15.0)) + F32(10.0))
    ty = ty * ty * ty * (ty * (ty * F32(6.0) - F32(15.0)) + F32(10.0))
    i0 = xi.astype(np.int32) % fx
    j0 = yi.astype(np.int32) % fy
    i1 = (i0 + 1) % fx
    j1 = (j0 + 1) % fy
    c00 = tab[j0, i0]
    c10 = tab[j0, i1]
    c01 = tab[j1, i0]
    c11 = tab[j1, i1]
    return (c00 + (c10 - c00) * tx) * (1 - ty) + (c01 + (c11 - c01) * tx) * ty


def fbm2(u, v, fx, fy, octaves=4, gain=0.5, lacunarity=2, tag="fbm"):
    """2D fBm：整数频率的周期值噪声叠加，结果仍在 [0,1] 且严格可平铺。"""
    total = None
    amp = 1.0
    norm = 0.0
    fxi, fyi = int(fx), int(fy)
    for k in range(int(octaves)):
        v_oct = pnoise(u, v, fxi, fyi, seed32(tag, k, fxi, fyi))
        total = v_oct * F32(amp) if total is None else total + v_oct * F32(amp)
        norm += amp
        amp *= gain
        fxi = max(int(round(fxi * lacunarity)), 1)
        fyi = max(int(round(fyi * lacunarity)), 1)
    return total / F32(norm)


# ----------------------------------------------------------------------------
# 三维值噪声（天空盒用；方向域连续，无需周期）
# ----------------------------------------------------------------------------
class Noise3:
    """三维格点值噪声（64^3 随机表），三线性 + 五次平滑，C2 连续。"""

    def __init__(self, seed: int, n: int = 64):
        self.n = int(n)
        self.mask = self.n - 1
        rng = np.random.default_rng(seed)
        self.table = rng.random(self.n ** 3, dtype=F32)

    def __call__(self, x, y, z):
        xf = np.floor(x)
        yf = np.floor(y)
        zf = np.floor(z)
        tx = (x - xf).astype(F32)
        ty = (y - yf).astype(F32)
        tz = (z - zf).astype(F32)
        tx = tx * tx * tx * (tx * (tx * F32(6.0) - F32(15.0)) + F32(10.0))
        ty = ty * ty * ty * (ty * (ty * F32(6.0) - F32(15.0)) + F32(10.0))
        tz = tz * tz * tz * (tz * (tz * F32(6.0) - F32(15.0)) + F32(10.0))
        xi = xf.astype(np.int32) & self.mask
        yi = yf.astype(np.int32) & self.mask
        zi = zf.astype(np.int32) & self.mask
        xj = (xi + 1) & self.mask
        yj = (yi + 1) & self.mask
        zj = (zi + 1) & self.mask
        n = self.n
        nn = n * n
        tbl = self.table

        def corner(a, b, c):
            return tbl.take(a * nn + b * n + c)

        c00 = corner(xi, yi, zi) + tx * (corner(xj, yi, zi) - corner(xi, yi, zi))
        c01 = corner(xi, yi, zj) + tx * (corner(xj, yi, zj) - corner(xi, yi, zj))
        c10 = corner(xi, yj, zi) + tx * (corner(xj, yj, zi) - corner(xi, yj, zi))
        c11 = corner(xi, yj, zj) + tx * (corner(xj, yj, zj) - corner(xi, yj, zj))
        c0 = c00 + ty * (c10 - c00)
        c1 = c01 + ty * (c11 - c01)
        return c0 + tz * (c1 - c0)


def noise3(tag: str) -> Noise3:
    nz = _N3_CACHE.get(tag)
    if nz is None:
        nz = Noise3(seed32("n3", tag))
        _N3_CACHE[tag] = nz
    return nz


def fbm3(x, y, z, scale=3.0, octaves=5, gain=0.5, lacunarity=2.0, tag="sky"):
    """三维 fBm（方向域上求值，方向连续则结果连续，跨面无缝）。"""
    nz = noise3(tag)
    total = None
    amp = 1.0
    norm = 0.0
    freq = float(scale)
    for k in range(int(octaves)):
        ox = 5.31 + 2.17 * k
        oy = 9.13 + 4.71 * k
        oz = 3.77 + 6.29 * k
        val = nz(x * freq + ox, y * freq + oy, z * freq + oz)
        total = val * F32(amp) if total is None else total + val * F32(amp)
        norm += amp
        amp *= gain
        freq *= lacunarity
    return total / F32(norm)


# ----------------------------------------------------------------------------
# 通用函数
# ----------------------------------------------------------------------------
def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def mix(a, b, t):
    """按 t 在颜色/标量间线性混合（支持 numpy 广播与 (3,) 颜色常量）。"""
    a = np.asarray(a, dtype=F32)
    b = np.asarray(b, dtype=F32)
    t = np.asarray(t, dtype=F32)
    out_ndim = max(a.ndim, b.ndim)
    if out_ndim == 1:
        # (3,) 颜色常量与逐像素蒙版混合：把蒙版补成 (..., 1) 以便广播
        if t.ndim >= 2:
            if t.shape[-1] != 1:
                t = t[..., None]
        else:
            t = t[..., None]
    else:
        while t.ndim < out_ndim:
            t = t[..., None]
    return a + (b - a) * t


def norm3(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), F32(1e-8))


def to_u8(rgb) -> np.ndarray:
    return np.clip(np.rint(np.asarray(rgb, dtype=F32) * 255.0), 0, 255).astype(np.uint8)


def grid(size: int):
    """返回 u=(1,size), v=(size,1) 的像素中心坐标，便于广播。"""
    c = (np.arange(size, dtype=F32) + 0.5) / F32(size)
    return c[None, :], c[:, None]


def normal_map(height, strength=4.0) -> np.ndarray:
    """由高度场生成切线空间法线贴图（环绕差分，保证无缝）。

    编码：R = (-dh/du)，G = (+dh/dv_img)，B = 1，归一化后 *0.5+0.5。
    图 v 向上（行号增大 → v 减小）时 G 取正，符合 OpenGL/WebGL 法线贴图约定。
    """
    h = np.asarray(height, dtype=F32)
    dh_dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * F32(0.5)
    dh_dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * F32(0.5)
    nx = -dh_dx * F32(strength)
    ny = dh_dy * F32(strength)
    nz = np.ones_like(h)
    n = np.stack([nx, ny, nz], axis=-1)
    n = norm3(n)
    return n * F32(0.5) + F32(0.5)


def seam_ratio(arr: np.ndarray) -> tuple[float, float]:
    """可平铺自检：首/末列(行)差 与 普通相邻列(行)差 的比值，越接近 1 越无缝。"""
    a = np.asarray(arr, dtype=np.float32)
    col = np.abs(a[:, 0] - a[:, -1]).mean()
    row = np.abs(a[0, :] - a[-1, :]).mean()
    adj_c = np.abs(np.diff(a, axis=1)).mean()
    adj_r = np.abs(np.diff(a, axis=0)).mean()
    return float(col / max(adj_c, 1e-6)), float(row / max(adj_r, 1e-6))


def save_png(name: str, rgb, usage: str, tileable: bool = True, mode: str = "RGB",
             report_seam: bool = True) -> dict:
    """保存 PNG（optimize=True），记录清单信息并打印。"""
    arr = to_u8(rgb)
    img = Image.fromarray(arr, mode=mode)
    path = TEX_DIR / name
    img.save(path, "PNG", optimize=True)
    size_kb = path.stat().st_size / 1024.0
    rec = {
        "file": name,
        "size": f"{img.width}x{img.height}",
        "usage": usage,
        "tileable": bool(tileable),
        "_kb": size_kb,
        "_mode": mode,
        "_seam": seam_ratio(arr) if report_seam else None,
    }
    _TEX_RECORDS.append(rec)
    return rec


def make_pil_mask(mask, color, alpha=1.0) -> np.ndarray:
    """把 0..1 蒙版叠成颜色（用于污渍/网格等）。"""
    m = np.clip(np.asarray(mask, dtype=F32), 0, 1) * F32(alpha)
    return mix(np.zeros(3, F32), np.asarray(color, F32), m)


# ----------------------------------------------------------------------------
# 1) 深色木地板 floor_wood + 法线
# ----------------------------------------------------------------------------
def make_floor_wood():
    W = H = 512
    u, v = grid(W)
    U, V = np.broadcast_arrays(u, v)

    planks = 8                      # 竖向 8 块板，每块 64 px
    boards_per_row = 2              # 横向每行 2 块，板长 256 px（错缝拼法）
    row = np.floor(V * planks).astype(np.int32)              # 0..7
    lv = V * planks - row                                    # 板内 v ∈ [0,1)
    shift = (row % 2) * F32(0.25)                            # 错缝：奇数行偏移半块
    t = (U - shift) * boards_per_row
    bf = np.floor(t)
    board = (bf.astype(np.int32)) % boards_per_row           # 板序号（跨缝一致）
    lu = t - bf                                              # 板内 u ∈ [0,1)
    # 到板缝的距离（像素）；min(lu,1-lu)*板长
    d_joint = np.minimum(lu, 1.0 - lu) * F32(1.0 / boards_per_row * W)
    # 到横向木条接缝的距离（像素）
    d_gap = np.minimum(lv, 1.0 - lv) * F32(H / planks)

    # 每块板一个随机相位与颜色偏移（周期噪声对平移不敏感，因此不会破坏无缝）
    rng = np.random.default_rng(seed32("floor_boards"))
    board_phase = (rng.random((planks, boards_per_row), dtype=F32) * F32(0.7))[row, board]
    tint = rng.uniform(-0.030, 0.030, (planks, boards_per_row, 3)).astype(F32)
    tint[..., 0] *= 1.0
    tint[..., 1] *= 0.55
    tint[..., 2] *= 0.35
    board_tint = tint[row, board]                            # (H, W, 3)
    board_shade = rng.uniform(-0.07, 0.07, (planks, boards_per_row)).astype(F32)[row, board]

    # 木纹：沿 x 拉长的多频噪声（低频 x / 高频 y），整体周期
    grain = fbm2(U + board_phase, V, 3, 44, octaves=4, gain=0.55, tag="grain")
    streak = fbm2(U + board_phase * 0.3, V, 2, 110, octaves=3, gain=0.5, tag="streak")
    fine = fbm2(U, V, 10, 110, octaves=3, gain=0.5, tag="grainfine")
    knot = fbm2(U, V, 2, 5, octaves=3, gain=0.5, tag="knot")

    base_light = np.array([0.465, 0.320, 0.200], F32)   # 深胡桃木
    base_dark = np.array([0.245, 0.160, 0.098], F32)
    shade_t = np.clip(0.36 + 1.55 * (grain - 0.5) + board_shade, 0.0, 1.0)
    wood = base_dark + (base_light - base_dark) * shade_t[..., None]
    wood = wood + board_tint
    wood = mix(wood, np.array([0.30, 0.195, 0.115], F32), 0.30 * smoothstep(0.58, 0.74, knot))
    # 顺纹细条纹
    wood *= (F32(0.84) + F32(0.30) * streak)[..., None]
    wood *= (F32(0.95) + F32(0.10) * (fine - 0.5))[..., None]

    # 板缝与横缝阴影（AO）
    joint_ao = smoothstep(0.0, 2.8, d_joint)            # 0 在缝上
    gap_ao = smoothstep(0.0, 3.6, d_gap)
    ao = (F32(0.26) + F32(0.74) * joint_ao) * (F32(0.28) + F32(0.72) * gap_ao)
    # 缝隙两侧的倒角高光（细木条边）
    bevel = np.exp(-((d_gap - 3.4) / 1.5) ** 2) * (V > 0.004)
    bevel_j = np.exp(-((d_joint - 2.6) / 1.4) ** 2)
    albedo = wood * ao[..., None] + ((F32(0.075) * bevel + F32(0.045) * bevel_j)[..., None]
                                     * np.array([1.0, 0.9, 0.75], F32))

    # 高度场：横缝凹槽 + 顺纹起伏 + 板面轻微倒角
    height = (F32(0.66)
              - F32(0.62) * (1.0 - gap_ao)
              - F32(0.30) * (1.0 - joint_ao)
              + F32(0.10) * (grain - 0.5)
              + F32(0.035) * (fine - 0.5))
    normal = normal_map(height, strength=5.0)

    save_png("floor_wood.png", albedo,
             "房间木地板 / 庭院木地面：横向木板条 + 错缝拼法，UV 重复平铺（约 2 块板宽 = 1 m）")
    save_png("floor_wood_normal.png", normal,
             "floor_wood 的切线空间法线贴图（板缝凹槽 + 木纹起伏），E1 法线贴图开关对比用",
             tileable=True, report_seam=False)
    return albedo, normal


# ----------------------------------------------------------------------------
# 2) 木箱 crate_wood + 法线
# ----------------------------------------------------------------------------
def make_crate_wood():
    W = H = 512
    u, v = grid(W)
    X, Y = np.broadcast_arrays(u, v)       # 0..1
    px = X * W
    py = Y * H
    in_x = np.minimum(px, W - px)          # 到左右边的距离
    in_y = np.minimum(py, H - py)          # 到上下边的距离
    dist_edge = np.minimum(in_x, in_y)

    frame = 46.0                            # 深色外框宽度
    inside = smoothstep(frame - 1.2, frame + 1.2, dist_edge)   # 1 = 内部板条区，0 = 外框

    # 木纹（周期噪声；横向拉长）
    grain = fbm2(X, Y, 3, 48, octaves=4, gain=0.55, tag="crate_grain")
    grain2 = fbm2(X, Y, 8, 96, octaves=3, gain=0.5, tag="crate_grain2")
    fine = fbm2(X, Y, 42, 42, octaves=3, gain=0.5, tag="crate_fine")
    gh = fbm2(X, Y, 2, 40, octaves=4, gain=0.55, tag="crate_frame_h")   # 横框木纹
    gv = fbm2(X, Y, 40, 2, octaves=4, gain=0.55, tag="crate_frame_v")   # 竖框木纹

    # --- 内部横向板条：5 条，缝隙约 3 px ---
    slats = 5
    inner_h = H - 2.0 * frame
    sy = np.clip((py - frame) / inner_h, 0.0, 1.0) * slats
    slat_local = sy - np.floor(sy)
    d_slat = np.minimum(slat_local, 1.0 - slat_local) * (inner_h / slats)
    slat_gap = 1.0 - smoothstep(0.0, 2.8, d_slat)

    rng = np.random.default_rng(seed32("crate_slats"))
    slat_shade = rng.uniform(-0.07, 0.07, slats).astype(F32)[np.clip(np.floor(sy), 0, slats - 1).astype(np.int32)]
    slat_light = np.array([0.635, 0.445, 0.275], F32)
    slat_dark = np.array([0.365, 0.235, 0.132], F32)
    slat_t = np.clip(0.44 + 1.25 * (grain - 0.5) + slat_shade, 0.0, 1.0)
    slat_col = slat_dark + (slat_light - slat_dark) * slat_t[..., None]
    slat_col *= (F32(0.90) + F32(0.20) * grain2)[..., None]
    slat_col *= (F32(0.96) + F32(0.08) * fine)[..., None]

    # --- 外框：深色木框，横框/竖框木纹方向不同 ---
    fg = np.where(in_x < in_y, gh, gv)
    frame_col = np.array([0.255, 0.165, 0.098], F32)
    frame_col = frame_col + (np.array([0.40, 0.275, 0.165], F32) - frame_col) \
        * np.clip(0.35 + 1.1 * (fg - 0.5), 0, 1)[..., None]
    # 外框内侧的阴影槽（框与板条交界处）
    groove = np.exp(-((dist_edge - frame) / 3.6) ** 2)
    # 外框外沿的轻微倒角高光
    outer_bevel = np.exp(-((dist_edge - 1.6) / 2.2) ** 2)

    # --- 四角金属包角：四分之一圆盘 + 倒角 + 边缘阴影 ---
    plate_r = 132.0
    d_corner = np.hypot(in_x, in_y)
    plate = smoothstep(plate_r + 1.2, plate_r - 1.2, d_corner)
    metal_base = np.array([0.315, 0.325, 0.345], F32)
    metal_col = metal_base + (np.array([0.46, 0.475, 0.50], F32) - metal_base) \
        * np.clip(0.30 + 1.5 * (fine - 0.5) + 0.30 * (grain - 0.5), 0, 1)[..., None]
    rim = np.exp(-((d_corner - (plate_r - 8.0)) / 2.6) ** 2)          # 内圈亮边
    edge_dark = np.exp(-((d_corner - plate_r) / 2.0) ** 2)            # 外缘暗边
    corner_dark = np.exp(-((d_corner - 4.0) / 10.0) ** 2)             # 角点压暗
    metal_col = metal_col + (F32(0.20) * rim)[..., None] * np.array([1.0, 0.97, 0.90], F32)
    metal_col *= (F32(1.0) - F32(0.55) * edge_dark)[..., None]
    metal_col *= (F32(1.0) - F32(0.30) * corner_dark)[..., None]

    # --- 铆钉 / 钉子（位置用取模距离，跨接缝一致）---
    rivets: list[tuple[float, float, float]] = []
    nails: list[tuple[float, float, float]] = []
    for cx, cy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
        bx = 0.0 if cx > 0 else W
        by = 0.0 if cy > 0 else H
        rivets += [(bx + cx * 27, by + cy * 27, 8.5),
                   (bx + cx * 27, by + cy * 86, 7.5),
                   (bx + cx * 86, by + cy * 27, 7.5),
                   (bx + cx * 57, by + cy * 57, 7.5)]
    nail_r = 3.0
    for k in range(8):
        cx = 32.0 + k * 64.0
        nails += [(cx, frame * 0.5, nail_r), (cx, H - frame * 0.5, nail_r)]
    for k in range(7):
        cy = 64.0 + k * 64.0
        nails += [(frame * 0.5, cy, nail_r), (W - frame * 0.5, cy, nail_r)]

    def _wrap_dist(cx, cy):
        dx = (px - cx + W * 0.5) % W - W * 0.5
        dy = (py - cy + H * 0.5) % H - H * 0.5
        return dx, dy

    rivet_h = np.zeros((H, W), F32)
    rivet_mask = np.zeros((H, W), F32)
    rivet_lit = np.zeros((H, W), F32)
    for cx, cy, r in rivets:
        dx, dy = _wrap_dist(cx, cy)
        d = np.hypot(dx, dy)
        dome = np.clip(1.0 - (d / r) ** 2, 0.0, 1.0)
        rivet_h = np.maximum(rivet_h, dome ** 0.85)
        rivet_mask = np.maximum(rivet_mask, smoothstep(r + 0.7, r - 0.7, d))
        lit = np.clip((-dx - dy) / max(r, 1e-3), 0.0, 1.0) ** 1.5
        rivet_lit = np.maximum(rivet_lit, lit * smoothstep(r, r - 1.0, d))

    nail_mask = np.zeros((H, W), F32)
    nail_hi = np.zeros((H, W), F32)
    for cx, cy, r in nails:
        dx, dy = _wrap_dist(cx, cy)
        d = np.hypot(dx, dy)
        nail_mask = np.maximum(nail_mask, smoothstep(r + 0.6, r - 0.6, d))
        dh = np.hypot(dx + 0.9, dy + 0.9)
        nail_hi = np.maximum(nail_hi, smoothstep(r - 0.2, r - 1.2, dh) * 0.9)

    # --- 组装颜色 ---
    col = mix(slat_col, frame_col, F32(1.0) - inside)
    col *= (F32(1.0) - F32(0.42) * (slat_gap * inside))[..., None]
    col *= (F32(1.0) - F32(0.38) * groove)[..., None]
    col += (F32(0.055) * outer_bevel)[..., None] * np.array([1.0, 0.92, 0.80], F32)
    col = mix(col, metal_col, plate)
    rivet_col = np.array([0.415, 0.425, 0.455], F32)
    rivet_base = rivet_col + (np.array([0.64, 0.65, 0.68], F32) - rivet_col) * rivet_h[..., None]
    col = mix(col, rivet_base, rivet_mask)
    col += (F32(0.24) * rivet_lit)[..., None] * np.array([1.0, 1.0, 1.0], F32)
    # 外框上的钉子：深色铁钉 + 左上小高光
    nail_col = np.array([0.245, 0.212, 0.185], F32)
    col = mix(col, nail_col, F32(0.92) * nail_mask)
    col += (F32(0.15) * nail_hi)[..., None] * np.array([1.0, 0.98, 0.92], F32)
    col = np.clip(col, 0, 1)

    # --- 高度场：板条缝凹槽 + 外框抬高 + 金属包角 + 铆钉/钉子凸起 ---
    height = (F32(0.50)
              - F32(0.55) * (slat_gap * inside)
              + F32(0.09) * (grain - 0.5)
              + F32(0.18) * (F32(1.0) - inside)
              - F32(0.30) * groove
              + F32(0.10) * plate
              + F32(0.09) * rim * plate
              + F32(0.75) * rivet_h
              + F32(0.22) * nail_mask)
    normal = normal_map(height, strength=4.4)

    save_png("crate_wood.png", col,
             "木箱六个面：木板条 + 深色外框 + 四角金属包角 + 铆钉，UV 每面一张（可平铺）")
    save_png("crate_wood_normal.png", normal,
             "crate_wood 的切线空间法线贴图（板条缝、外框、金属包角与铆钉凸起）",
             tileable=True, report_seam=False)
    return col, normal


# ----------------------------------------------------------------------------
# 3) 抹灰墙 wall_plaster
# ----------------------------------------------------------------------------
def make_wall_plaster():
    W = H = 512
    u, v = grid(W)
    U, V = np.broadcast_arrays(u, v)

    base = np.array([0.650, 0.602, 0.545], F32)
    # 低频不均匀亮度（大块暖冷变化）
    low = fbm2(U, V, 2, 2, octaves=4, gain=0.55, tag="plaster_low")
    mid = fbm2(U, V, 5, 5, octaves=4, gain=0.5, tag="plaster_mid")
    fine = fbm2(U, V, 64, 64, octaves=3, gain=0.5, tag="plaster_fine")
    micro = fbm2(U, V, 180, 180, octaves=3, gain=0.5, tag="plaster_micro")
    trowel = fbm2(U, V, 3, 28, octaves=3, gain=0.5, tag="plaster_trowel")

    col = base[None, None, :].repeat(H, 0).repeat(W, 1)
    col = col * (F32(0.88) + F32(0.24) * low)[..., None]
    col = col * (F32(0.97) + F32(0.06) * mid)[..., None]
    col = col * (F32(1.0) + F32(0.065) * (fine - 0.5) + F32(0.045) * (micro - 0.5)
                 + F32(0.03) * (trowel - 0.5))[..., None]

    # 轻微污渍斑块（柔和、不抢眼）
    stain = smoothstep(0.60, 0.80, fbm2(U, V, 4, 3, octaves=5, gain=0.55, tag="plaster_stain"))
    stain2 = smoothstep(0.68, 0.85, fbm2(U, V, 9, 7, octaves=4, gain=0.5, tag="plaster_stain2"))
    col = mix(col, np.array([0.470, 0.425, 0.375], F32), np.clip(0.30 * stain + 0.16 * stain2, 0, 1))
    # 极小气孔 / 掉粒
    pits = smoothstep(0.78, 0.92, micro)
    col = mix(col, np.array([0.415, 0.385, 0.345], F32), 0.12 * pits)

    col = np.clip(col, 0, 1)
    save_png("wall_plaster.png", col,
             "房间四壁 / 庭院围墙：暖灰米色抹灰，细颗粒 + 轻微污渍 + 低频明暗，可平铺")
    return col


# ----------------------------------------------------------------------------
# 4) 棋盘格 tile_checker（含半透明 U/V 标注）
# ----------------------------------------------------------------------------
def make_tile_checker():
    W = H = 512
    u, v = grid(W)
    U, V = np.broadcast_arrays(u, v)

    cells = 8
    cx = np.floor(U * cells).astype(np.int32)
    cy = np.floor(V * cells).astype(np.int32)
    checker = ((cx + cy) % 2).astype(F32)

    dark = np.array([0.275, 0.295, 0.325], F32)
    light = np.array([0.635, 0.655, 0.675], F32)
    col = mix(dark, light, checker[..., None])
    grain = fbm2(U, V, 12, 12, octaves=3, gain=0.5, tag="checker_grain")
    col *= (F32(0.97) + F32(0.06) * (grain - 0.5))[..., None]

    # 细网格线：画在单元格边界，用环绕距离使其在 u=0/v=0 处也对齐
    fu = U * cells - np.floor(U * cells)
    fv = V * cells - np.floor(V * cells)
    dline = np.minimum(np.minimum(fu, 1.0 - fu), np.minimum(fv, 1.0 - fv)) * (W / cells)
    line = smoothstep(1.6, 0.4, dline)
    col = mix(col, np.array([0.145, 0.155, 0.175], F32), 0.85 * line[..., None])
    # 网格线一侧的高光，增加厚度感
    hi = smoothstep(3.2, 1.9, dline) * (1.0 - line)
    col += (F32(0.10) * hi)[..., None]

    img = Image.fromarray(to_u8(np.clip(col, 0, 1)), "RGB").convert("RGBA")
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font_path = "C:/Windows/Fonts/msyhbd.ttc"
    if not os.path.exists(font_path):
        font_path = "C:/Windows/Fonts/simhei.ttf"
    font = ImageFont.truetype(font_path, 46)
    # 标注放在图像内部、离边缘留足余量，不破坏棋盘格自身的可平铺性
    tcol = (255, 255, 255, 165)
    draw.text((34, 34), "U→", font=font, fill=tcol, stroke_width=1, stroke_fill=(0, 0, 0, 70))
    draw.text((34, 200), "V↓", font=font, fill=tcol, stroke_width=1, stroke_fill=(0, 0, 0, 70))
    draw.text((330, 34), "8×8", font=font, fill=(255, 255, 255, 130),
              stroke_width=1, stroke_fill=(0, 0, 0, 60))
    img = Image.alpha_composite(img, overlay).convert("RGB")
    arr = np.asarray(img, dtype=np.uint8)
    save_png("tile_checker.png", arr.astype(F32) / F32(255.0),
             "UV 演示平面：8×8 双色棋盘格 + 细网格线，半透明 U→/V↓ 标注用于 README 讲 UV 数据流",
             tileable=True, report_seam=False)
    return arr


# ----------------------------------------------------------------------------
# 5) 大理石 marble
# ----------------------------------------------------------------------------
def make_marble():
    W = H = 512
    u, v = grid(W)
    U, V = np.broadcast_arrays(u, v)

    base = np.array([0.878, 0.868, 0.852], F32)
    turb = fbm2(U, V, 3, 3, octaves=5, gain=0.55, tag="marble_turb") - 0.5
    warp = fbm2(U, V, 6, 6, octaves=4, gain=0.5, tag="marble_warp") - 0.5
    cloud = fbm2(U, V, 4, 4, octaves=4, gain=0.5, tag="marble_cloud") - 0.5
    fine = fbm2(U, V, 80, 80, octaves=3, gain=0.5, tag="marble_fine")
    wid = fbm2(U, V, 4, 3, octaves=4, gain=0.5, tag="marble_wid")

    col = base[None, None, :].repeat(H, 0).repeat(W, 1)
    col = col * (F32(0.962) + F32(0.075) * cloud)[..., None]
    col = col * (F32(1.0) + F32(0.018) * (fine - 0.5))[..., None]

    # 主纹脉：低频正弦相位 + 强域扭曲（有机蜿蜒），芯线 + 柔和宽晕
    ph1 = 2.0 * math.pi * (U * 2.0 + V * 1.0 + 1.7 * turb)
    sin1 = np.sin(ph1)
    core = smoothstep(0.16, 0.0, np.abs(sin1))
    halo = smoothstep(0.72, 0.0, np.abs(sin1))
    vein = core * (0.50 + 0.50 * wid)
    col = mix(col, np.array([0.515, 0.530, 0.575], F32), np.clip(0.75 * vein + 0.10 * halo, 0, 1))
    # 第二组方向（弱一些）
    ph2 = 2.0 * math.pi * (U * 1.0 - V * 3.0 + 1.3 * warp)
    core2 = smoothstep(0.10, 0.0, np.abs(np.sin(ph2)))
    col = mix(col, np.array([0.590, 0.600, 0.635], F32),
              np.clip(0.30 * core2 * (0.55 + 0.45 * wid), 0, 1))
    # 第三组极细短脉
    ph3 = 2.0 * math.pi * (U * 5.0 + V * 2.0 + 1.1 * warp)
    core3 = smoothstep(0.08, 0.0, np.abs(np.sin(ph3)))
    col = mix(col, np.array([0.660, 0.655, 0.675], F32), np.clip(0.18 * core3, 0, 1))
    # 暖色雾斑，避免整体过冷
    col = mix(col, np.array([0.810, 0.770, 0.710], F32), 0.20 * smoothstep(0.25, 0.75, cloud + 0.5))
    col = np.clip(col, 0, 1)
    save_png("marble.png", col,
             "台座 / 圆柱 / 雕塑底座：浅色大理石，柔和纹脉与细碎颗粒，可平铺")
    return col


# ----------------------------------------------------------------------------
# 6) 无缝黄昏天空盒
# ----------------------------------------------------------------------------
def cube_dirs(face: str, size: int):
    """按 WebGL/OpenGL 立方体贴图标准映射，返回该面每个像素的方向向量。

    PNG 第 0 行 = GL 的 t=0（WebGL 默认 UNPACK_FLIP_Y=false），因此 PNG 顶部 = 天空上方。
    """
    s = (np.arange(size, dtype=F32) + 0.5) / F32(size)
    t = (np.arange(size, dtype=F32) + 0.5) / F32(size)
    U, T = np.meshgrid(s, t)          # (H, W)
    uu = U * 2.0 - 1.0                 # -1..1 向右
    vv = T * 2.0 - 1.0                 # -1..1 向下
    if face == "px":
        d = np.stack([np.ones_like(uu), -vv, -uu], axis=-1)
    elif face == "nx":
        d = np.stack([-np.ones_like(uu), -vv, uu], axis=-1)
    elif face == "py":
        d = np.stack([uu, np.ones_like(uu), vv], axis=-1)
    elif face == "ny":
        d = np.stack([uu, -np.ones_like(uu), -vv], axis=-1)
    elif face == "pz":
        d = np.stack([uu, -vv, np.ones_like(uu)], axis=-1)
    elif face == "nz":
        d = np.stack([-uu, -vv, -np.ones_like(uu)], axis=-1)
    else:
        raise ValueError(face)
    return norm3(d)


def sky_colors(d):
    """连续的程序化黄昏天空：只依赖方向 d，所以跨立方体面天然无缝。"""
    d = norm3(d)
    x = d[..., 0]
    y = d[..., 1]
    z = d[..., 2]
    h = y                                   # 方向仰角正弦（地平线 y=0）

    # --- 天幕基础渐变：天顶深蓝紫 → 地平线暖橙 ---
    zenith = np.array([0.070, 0.085, 0.235], F32)
    mid_sky = np.array([0.235, 0.205, 0.420], F32)
    horizon = np.array([0.985, 0.575, 0.320], F32)
    col = mix(horizon, mid_sky, smoothstep(0.0, 0.34, h))
    col = mix(col, zenith, smoothstep(0.28, 0.95, h))
    # 地平线暖光带（太阳一侧更亮）
    band = np.exp(-((h - 0.012) / 0.105) ** 2)
    col = mix(col, np.array([1.0, 0.66, 0.40], F32), band * 0.42)

    # --- 太阳（低垂、暖白、带光晕）---
    sd = np.clip(x * HORIZON_SUN[0] + y * HORIZON_SUN[1] + z * HORIZON_SUN[2], -1.0, 1.0)
    cos_inner = math.cos(math.radians(0.9))
    cos_outer = math.cos(math.radians(2.4))
    disc = smoothstep(cos_outer, cos_inner, sd)
    halo = (np.clip(sd, 0.0, 1.0) ** 1400) * 0.55 \
        + (np.clip(sd, 0.0, 1.0) ** 90) * 0.45 \
        + (np.clip(sd, 0.0, 1.0) ** 7) * 0.30
    sun_vis = smoothstep(-0.045, 0.03, h)
    sun_col = np.array([1.0, 0.93, 0.78], F32)
    col = col + sun_col * ((disc * 1.9 + halo) * sun_vis)[..., None]

    # --- 云层：方向域多频噪声 + 域扭曲 + 分层高度带 ---
    w = fbm3(x, y, z, scale=1.7, octaves=4, tag="cloud_warp")
    wx = x * 2.9 + (w - 0.5) * 1.5
    wy = y * 4.6 + (w - 0.5) * 0.9
    wz = z * 2.9 + (w - 0.5) * 1.5
    n1 = fbm3(wx, wy, wz, scale=1.0, octaves=5, tag="cloud_a")
    n2 = fbm3(x * 5.4, y * 7.0, z * 5.4, scale=1.0, octaves=4, tag="cloud_b")

    band1 = np.exp(-((h - 0.10) / 0.17) ** 2) * 0.95 + np.exp(-((h - 0.30) / 0.20) ** 2) * 0.65
    band1 *= smoothstep(-0.02, 0.04, h)
    dens1 = smoothstep(0.50, 0.70, n1) * band1
    band2 = np.exp(-((h - 0.035) / 0.055) ** 2) * smoothstep(-0.01, 0.02, h)
    dens2 = smoothstep(0.55, 0.78, n2) * band2 * 0.75
    dens = np.clip(dens1 + dens2, 0.0, 1.0)

    sun_lit = np.clip((sd + 0.15) / 1.15, 0.0, 1.0)
    cloud_shadow = np.array([0.30, 0.265, 0.395], F32)
    cloud_lit = np.array([1.0, 0.775, 0.60], F32)
    cloud_col = mix(cloud_shadow, cloud_lit, (sun_lit ** 1.4) * 0.92)
    cloud_col = cloud_col * (F32(0.80) + F32(0.35) * dens)[..., None]
    # 云底靠近地平线时更暖更亮
    cloud_col = mix(cloud_col, np.array([1.0, 0.72, 0.50], F32), band2 * 0.35)
    col = mix(col, cloud_col, dens * 0.88)

    # --- 地平线以下：远山剪影（方位角连续）+ 暖灰地面 ---
    r = np.sqrt(x * x + z * z) + F32(1e-6)
    cx = x / r
    cz = z / r
    ridge = 0.006 + 0.060 * fbm3(cx * 2.4, F32(0.5), cz * 2.4, scale=1.0, octaves=4, tag="ridge")
    ridge += 0.022 * fbm3(cx * 6.5, F32(1.5), cz * 6.5, scale=1.0, octaves=3, tag="ridge2")
    mountain = smoothstep(ridge + 0.006, ridge - 0.030, h) * smoothstep(-0.42, -0.08, h)
    mountain_col = mix(np.array([0.13, 0.115, 0.175], F32),
                       np.array([0.33, 0.235, 0.275], F32),
                       smoothstep(-0.02, 0.10, h))
    col = mix(col, mountain_col, np.clip(mountain * 1.1, 0.0, 0.95))

    ground = smoothstep(-0.015, -0.14, h)
    ground_col = mix(np.array([0.155, 0.120, 0.135], F32),
                     np.array([0.070, 0.055, 0.075], F32),
                     smoothstep(-0.20, -0.95, h))
    col = mix(col, ground_col, ground)

    # --- 压暗地平线以下整体亮度（黄昏地面几乎无直射光）---
    col = col * (F32(1.0) - F32(0.20) * smoothstep(0.0, -0.5, h))[..., None]

    # 轻微色调映射 + 8x8 有序抖动，既避免大面积渐变出现色带，又保持 PNG 体积小
    col = np.clip(col, 0.0, 1.0)
    col = col / (F32(1.0) + F32(0.20) * col)
    col = np.clip(col + ordered_dither(d.shape[:2]), 0.0, 1.0)
    return col


_BAYER8 = (np.array([
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
], dtype=F32) / F32(64.0) - F32(0.5))


def ordered_dither(shape) -> np.ndarray:
    """8x8 Bayer 有序抖动（±1 LSB），周期性图案压缩效率远高于随机噪声。"""
    h, w = int(shape[0]), int(shape[1])
    tile = np.tile(_BAYER8, (h // 8 + 1, w // 8 + 1))[:h, :w]
    return (tile / F32(255.0))[..., None]


def make_cubemap(size: int = 1024):
    faces = ["px", "nx", "py", "ny", "pz", "nz"]
    imgs = {}
    for face in faces:
        d = cube_dirs(face, size)
        rgb = sky_colors(d)
        img = Image.fromarray(to_u8(rgb), "RGB")
        path = CUBE_DIR / f"{face}.png"
        img.save(path, "PNG", optimize=True)
        imgs[face] = np.asarray(img, dtype=np.float32) / 255.0
        print(f"  cubemap/{face}.png  {size}x{size}  {path.stat().st_size / 1024.0:8.1f} KB")
    _seam_check_cubemap(imgs)

    # 自检预览：十字展开图（仅供人工检查，最终不保留在 assets 内）
    return imgs


def _seam_check_cubemap(imgs: dict):
    """验证六面公共棱颜色连续：相邻面棱边像素差应与面内相邻像素差同量级。"""
    face = {k: (v * 255.0).astype(np.float32) for k, v in imgs.items()}
    pairs = [
        ("pz右- px左", face["pz"][:, -1, :], face["px"][:, 0, :]),
        ("px右- nz左", face["px"][:, -1, :], face["nz"][:, 0, :]),
        ("nz右- nx左", face["nz"][:, -1, :], face["nx"][:, 0, :]),
        ("nx右- pz左", face["nx"][:, -1, :], face["pz"][:, 0, :]),
        ("pz上- py下", face["pz"][0, :, :], face["py"][-1, :, :]),
        ("pz下- ny上", face["pz"][-1, :, :], face["ny"][0, :, :]),
        ("py上- nz上(反向)", face["py"][0, :, :], face["nz"][0, ::-1, :]),
        ("ny下- nz下(反向)", face["ny"][-1, :, :], face["nz"][-1, ::-1, :]),
        ("px上- py右(反向)", face["px"][0, :, :], face["py"][::-1, -1, :]),
        ("px下- ny右", face["px"][-1, :, :], face["ny"][:, -1, :]),
        ("nx上- py左", face["nx"][0, :, :], face["py"][:, 0, :]),
        ("nx下- ny左(反向)", face["nx"][-1, :, :], face["ny"][::-1, 0, :]),
    ]
    print("  cubemap 棱边连续性（0~255 灰度差，越小越连续；面内相邻像素差 ≈ 1~3）：")
    worst = 0.0
    for label, a, b in pairs:
        diff = float(np.abs(a - b).mean())
        worst = max(worst, diff)
        flag = "OK " if diff < 8.0 else "!! "
        print(f"    {flag}{label:22s} mean|Δ| = {diff:6.2f}")
    print(f"  最差棱边平均差 = {worst:.2f}（阈值 8.0）")


# ----------------------------------------------------------------------------
# 天空盒人工自检预览（仅在 --preview 时输出到 docs/diagrams/，最终可删除）
# ----------------------------------------------------------------------------
def _env_lookup(imgs: dict, d):
    """用与 WebGL 立方体贴图相同的规则把方向向量 d 采样成颜色（双线性）。"""
    size = imgs["px"].shape[0]
    d = norm3(d)
    x, y, z = d[..., 0], d[..., 1], d[..., 2]
    ax, ay, az = np.abs(x), np.abs(y), np.abs(z)
    major = np.argmax(np.stack([ax, ay, az], axis=-1), axis=-1)
    comp = np.choose(major, [x, y, z])
    face_idx = major * 2 + (comp < 0)
    ex = np.where(np.abs(x) < 1e-8, 1e-8, x)
    ey = np.where(np.abs(y) < 1e-8, 1e-8, y)
    ez = np.where(np.abs(z) < 1e-8, 1e-8, z)
    spx, tpx = (-z / ex + 1.0) * 0.5, (-y / ex + 1.0) * 0.5
    snx, tnx = (z / (-ex) + 1.0) * 0.5, (-y / (-ex) + 1.0) * 0.5
    spy, tpy = (x / ey + 1.0) * 0.5, (z / ey + 1.0) * 0.5
    sny, tny = (x / (-ey) + 1.0) * 0.5, (-z / (-ey) + 1.0) * 0.5
    spz, tpz = (x / ez + 1.0) * 0.5, (-y / ez + 1.0) * 0.5
    snz, tnz = (x / ez + 1.0) * 0.5, (y / ez + 1.0) * 0.5

    s = np.where(major == 0, np.where(x > 0, spx, snx),
                 np.where(major == 1, np.where(y > 0, spy, sny),
                          np.where(z > 0, spz, snz)))
    t = np.where(major == 0, np.where(x > 0, tpx, tnx),
                 np.where(major == 1, np.where(y > 0, tpy, tny),
                          np.where(z > 0, tpz, tnz)))

    out = np.zeros(d.shape, F32)
    faces = ["px", "nx", "py", "ny", "pz", "nz"]
    gx = np.clip(s * size - 0.5, 0.0, size - 1.0)
    gy = np.clip(t * size - 0.5, 0.0, size - 1.0)
    x0 = np.floor(gx).astype(np.int32)
    y0 = np.floor(gy).astype(np.int32)
    x1 = np.minimum(x0 + 1, size - 1)
    y1 = np.minimum(y0 + 1, size - 1)
    fx = (gx - x0)[..., None]
    fy = (gy - y0)[..., None]
    for fi, f in enumerate(faces):
        m = face_idx == fi
        if not m.any():
            continue
        arr = imgs[f]
        c00 = arr[y0[m], x0[m]]
        c10 = arr[y0[m], x1[m]]
        c01 = arr[y1[m], x0[m]]
        c11 = arr[y1[m], x1[m]]
        out[m] = (c00 * (1 - fx[m]) + c10 * fx[m]) * (1 - fy[m]) + \
                 (c01 * (1 - fx[m]) + c11 * fx[m]) * fy[m]
    return out


def write_preview(imgs: dict):
    """输出天空盒十字展开图 + 环境反射球，用于人工检查接缝与朝向。"""
    out_dir = ROOT / "docs" / "diagrams"
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1) 十字展开图
    fs = 300
    cross = Image.new("RGB", (4 * fs, 3 * fs), (12, 16, 20))
    layout = {"nx": (0, 1), "py": (1, 0), "pz": (1, 1), "px": (2, 1),
              "ny": (1, 2), "nz": (3, 1)}
    for f, (cx, cy) in layout.items():
        face_img = Image.fromarray(to_u8(imgs[f]), "RGB").resize((fs, fs), Image.LANCZOS)
        cross.paste(face_img, (cx * fs, cy * fs))
    path_cross = out_dir / "_preview_cubemap_cross.png"
    cross.save(path_cross, "PNG", optimize=True)

    # 2) 环境反射球（验证太阳/渐变/接缝在反射中是否正常）
    size = 520
    R = size * 0.5 - 6.0
    yy, xx = np.mgrid[0:size, 0:size]
    sx = (xx + 0.5 - size * 0.5) / R
    sy = (yy + 0.5 - size * 0.5) / R
    r2 = sx * sx + sy * sy
    inside = r2 < 1.0
    nz = np.sqrt(np.clip(1.0 - r2, 0.0, 1.0))
    n = norm3(np.stack([sx, -sy, nz], axis=-1))
    ndv = np.clip(n[..., 2], 0.0, 1.0)
    rv = 2.0 * ndv[..., None] * n - np.array([0.0, 0.0, 1.0], F32)
    env = _env_lookup(imgs, rv)
    fresnel = 0.72 + 0.28 * (1.0 - ndv) ** 3
    sphere = np.clip(env * fresnel[..., None], 0, 1)
    bg = np.array([0.055, 0.06, 0.075], F32)[None, None, :] * \
        (0.35 + 0.9 * np.clip(1.0 - r2, 0.0, 1.0))[..., None]
    out = np.where(inside[..., None], sphere, bg)
    path_sphere = out_dir / "_preview_env_sphere.png"
    Image.fromarray(to_u8(np.clip(out, 0, 1)), "RGB").save(path_sphere, "PNG", optimize=True)
    print(f"  预览自检图：{path_cross}")
    print(f"              {path_sphere}")


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
def main():
    for d in (TEX_DIR, CUBE_DIR):
        d.mkdir(parents=True, exist_ok=True)
    print(f"AP3 贴图生成器（种子 {MASTER_SEED}）")
    print(f"输出目录：{TEX_DIR}")
    print(f"          {CUBE_DIR}\n")

    print("[1/7] 木地板 + 法线贴图 ...")
    make_floor_wood()
    print("[2/7] 木箱 + 法线贴图 ...")
    make_crate_wood()
    print("[3/7] 抹灰墙 ...")
    make_wall_plaster()
    print("[4/7] 棋盘格 ...")
    make_tile_checker()
    print("[5/7] 大理石 ...")
    make_marble()
    print("[6/7] 黄昏天空盒（6 面）...")
    cube_imgs = make_cubemap(1024)
    if "--preview" in sys.argv:
        write_preview(cube_imgs)
    print("[7/7] 写 manifest.json ...")

    manifest = [{k: rec[k] for k in ("file", "size", "usage", "tileable")} for rec in _TEX_RECORDS]
    (TEX_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # ---------------- 自检清单 ----------------
    print("\n" + "=" * 88)
    print(f"{'文件':32s}{'尺寸':>10s}{'模式':>6s}{'字节':>10s}{'KB':>9s}  无缝(列/行)")
    print("-" * 88)
    tex_bytes = 0
    ok = True
    for rec in _TEX_RECORDS:
        path = TEX_DIR / rec["file"]
        with Image.open(path) as im:
            im.load()
            size_ok = im.size == (512, 512)
            mode_ok = im.mode in ("RGB", "RGBA")
        kb = path.stat().st_size / 1024.0
        tex_bytes += path.stat().st_size
        seam = rec["_seam"]
        seam_txt = "-" if seam is None else f"{seam[0]:.2f}/{seam[1]:.2f}"
        size_flag = "" if size_ok and mode_ok else "  <-- 尺寸/模式异常"
        if not size_ok or not mode_ok or kb > 500:
            ok = False
        print(f"{rec['file']:32s}{rec['size']:>10s}{rec['_mode']:>6s}"
              f"{path.stat().st_size:>10d}{kb:>9.1f}  {seam_txt}{size_flag}")
    cube_bytes = sum((CUBE_DIR / f"{f}.png").stat().st_size for f in ("px", "nx", "py", "ny", "pz", "nz"))
    total = tex_bytes + cube_bytes
    print("-" * 88)
    print(f"textures 合计 {tex_bytes / 1024.0 / 1024.0:.2f} MB + cubemap {cube_bytes / 1024.0 / 1024.0:.2f} MB"
          f" = {total / 1024.0 / 1024.0:.2f} MB（上限 6.00 MB）")
    print(f"manifest.json：{len(manifest)} 项")
    print("自检：" + ("通过（尺寸/模式/单张 ≤500KB/assets ≤6MB）" if ok and total <= 6 * 1024 * 1024
                    else "存在超限项，请检查上方标注"))
    print("=" * 88)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AP3 README 原理示意图生成器（Pillow 直接绘制，不依赖浏览器 / SVG）。

用法：
    python tools/make_diagrams.py

输出（1600×900，按 2 倍分辨率绘制后 LANCZOS 缩放，字形清晰，中文标注）：
    docs/diagrams/uv-dataflow.png         顶点 UV → 纹理采样 → 片元颜色 数据流
    docs/diagrams/shadow-two-pass.png     阴影贴图两遍渲染（光源深度 → 相机深度比较）
    docs/diagrams/phong-components.png    Phong 光照三分量（环境 / 漫反射 / 镜面 + 合成）
    docs/diagrams/picking-flow.png        颜色编码拾取（ID 颜色 FBO → readPixels → 反解）
    docs/diagrams/pipeline-overview.png   总体渲染管线与模块划分

设计约定：
  * 深色背景 #12161c，朴素扁平工程示意风格；青 / 橙 / 紫三色分别表示三类概念。
  * 所有文字用微软雅黑（中文）/ Consolas（代码），绘制前用 textbbox/getlength 量宽度，
    过长的文本自动换行或缩小字号，避免超框；坐标统一按 FINAL 像素给出，内部 ×2 采样。
  * 图内所有渲染物（Phong 小球、天空盒贴图缩略图）都由脚本自身生成/读取本地资产，
    不联网、不启动浏览器。
"""

from __future__ import annotations

import math
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ----------------------------------------------------------------------------
# 画布与配色
# ----------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "docs" / "diagrams"
TEX_DIR = ROOT / "assets" / "textures"

W, H = 1600, 900
S = 2                                    # 超采样倍数
BG = (18, 22, 28)
PANEL = (26, 33, 43)
PANEL2 = (31, 40, 52)
CODEBG = (13, 17, 22)
BORDER = (46, 58, 74)
TEXT = (232, 237, 243)
MUTED = (160, 172, 186)
DIM = (114, 127, 142)
CYAN = (64, 196, 230)
ORANGE = (246, 146, 60)
PURPLE = (167, 139, 250)
GREEN = (72, 209, 156)
RED = (248, 113, 113)
YELLOW = (250, 204, 21)
WHITE = (255, 255, 255)

FONT_REG = "C:/Windows/Fonts/msyh.ttc"
FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_CODE = "C:/Windows/Fonts/consola.ttf"

_TOKEN_RE = re.compile(
    r"[A-Za-z0-9_@#\$%^&\.\,\:\;\(\)\[\]\{\}\+\-\*/=<>!\?~\|'\"]+|\s+|.")


# ----------------------------------------------------------------------------
# 绘图封装（所有坐标按最终 1600×900 像素给出，内部乘 S）
# ----------------------------------------------------------------------------
class Canvas:
    def __init__(self):
        self.img = Image.new("RGB", (W * S, H * S), BG)
        self.d = ImageDraw.Draw(self.img)
        self._fonts: dict[tuple, ImageFont.FreeTypeFont] = {}

    # ---- 字体与文本 ----
    def font(self, size, bold=False, code=False):
        key = (round(float(size), 1), bool(bold), bool(code))
        f = self._fonts.get(key)
        if f is None:
            path = FONT_CODE if code else (FONT_BOLD if bold else FONT_REG)
            f = ImageFont.truetype(path, max(int(round(size * S)), 8))
            self._fonts[key] = f
        return f

    def textlen(self, s, size, bold=False, code=False):
        return self.font(size, bold, code).getlength(s) / S

    def fit_size(self, s, size, maxw, bold=False, code=False, min_size=9):
        size = float(size)
        while size > min_size and self.textlen(s, size, bold, code) > maxw:
            size -= 0.5
        return size

    def wrap(self, s, size, maxw, bold=False, code=False):
        lines, cur = [], ""
        for tok in _TOKEN_RE.findall(s):
            cand = cur + tok
            if not cur or self.textlen(cand, size, bold, code) <= maxw:
                cur = cand
            else:
                lines.append(cur.rstrip())
                cur = "" if tok.isspace() else tok
        if cur.strip():
            lines.append(cur.rstrip())
        return lines

    def text(self, x, y, s, size=18, color=TEXT, bold=False, code=False,
             anchor="lt", maxw=None):
        if "\n" in s:
            lines = s.split("\n")
            lh = size * 1.4
            y0 = y - (len(lines) - 1) * lh / 2 if anchor[1] == "m" else y
            for i, ln in enumerate(lines):
                self.text(x, y0 + i * lh, ln, size, color, bold=bold,
                          code=code, anchor=anchor, maxw=maxw)
            return size
        if maxw is not None:
            size = self.fit_size(s, size, maxw, bold, code)
        self.d.text((x * S, y * S), s, font=self.font(size, bold, code),
                    fill=color, anchor=anchor)
        return size

    def para(self, x, y, s, size=17, color=TEXT, maxw=400, line=1.55,
             bold=False, code=False):
        cy = float(y)
        for seg in s.split("\n"):
            for ln in self.wrap(seg, size, maxw, bold, code):
                self.text(x, cy, ln, size, color, bold=bold, code=code)
                cy += size * line
        return cy

    # ---- 图形 ----
    def rrect(self, box, r=14, fill=PANEL, outline=BORDER, width=1.6):
        x0, y0, x1, y1 = box
        self.d.rounded_rectangle(
            (x0 * S, y0 * S, x1 * S, y1 * S), radius=r * S,
            fill=fill, outline=outline, width=max(1, int(round(width * S))))

    def rect(self, box, fill=PANEL, outline=None, width=1.2):
        x0, y0, x1, y1 = box
        self.d.rectangle((x0 * S, y0 * S, x1 * S, y1 * S), fill=fill,
                         outline=outline, width=max(1, int(round(width * S))))

    def line(self, p0, p1, color, width=2.0):
        self.d.line((p0[0] * S, p0[1] * S, p1[0] * S, p1[1] * S),
                    fill=color, width=max(1, int(round(width * S))))

    def dashed(self, points, color, width=1.6, dash=9, gap=7):
        for i in range(len(points) - 1):
            p0, p1 = points[i], points[i + 1]
            dx, dy = p1[0] - p0[0], p1[1] - p0[1]
            length = math.hypot(dx, dy)
            if length < 1e-6:
                continue
            ux, uy = dx / length, dy / length
            t = 0.0
            while t < length:
                t2 = min(t + dash, length)
                self.line((p0[0] + ux * t, p0[1] + uy * t),
                          (p0[0] + ux * t2, p0[1] + uy * t2), color, width)
                t += dash + gap

    def arrow(self, points, color, width=2.2, head=11.0):
        pts = [(float(x), float(y)) for x, y in points]
        for i in range(len(pts) - 1):
            self.line(pts[i], pts[i + 1], color, width)
        (x0, y0), (x1, y1) = pts[-2], pts[-1]
        ang = math.atan2(y1 - y0, x1 - x0)
        hs, hw = head, head * 0.55
        a = (x1 - hs * math.cos(ang) + hw * math.sin(ang),
             y1 - hs * math.sin(ang) - hw * math.cos(ang))
        b = (x1 - hs * math.cos(ang) - hw * math.sin(ang),
             y1 - hs * math.sin(ang) + hw * math.cos(ang))
        self.d.polygon([(x1 * S, y1 * S), (a[0] * S, a[1] * S), (b[0] * S, b[1] * S)],
                       fill=color)

    def circle(self, cx, cy, r, fill=None, outline=None, width=2.0):
        self.d.ellipse(((cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S),
                       fill=fill, outline=outline,
                       width=max(1, int(round(width * S))) if outline else 0)

    def dot(self, cx, cy, r=4, color=YELLOW):
        self.circle(cx, cy, r, fill=color)

    def polygon(self, pts, fill=None, outline=None, width=2.0):
        self.d.polygon([(x * S, y * S) for x, y in pts], fill=fill, outline=outline,
                       width=max(1, int(round(width * S))))

    def pasted(self, img, x, y, w, h):
        im = img.convert("RGBA").resize((max(1, int(w * S)), max(1, int(h * S))), Image.LANCZOS)
        self.img.paste(im, (int(x * S), int(y * S)), im)

    # ---- 保存 ----
    def save(self, name):
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        path = OUT_DIR / name
        self.img.resize((W, H), Image.LANCZOS).save(path, "PNG", optimize=True)
        with Image.open(path) as im:
            print(f"  {name:26s} {im.size[0]}x{im.size[1]}  {im.mode}  "
                  f"{path.stat().st_size / 1024.0:7.1f} KB")
        return path


# ----------------------------------------------------------------------------
# 通用组件
# ----------------------------------------------------------------------------
def title(c: Canvas, main: str, sub: str):
    c.d.rectangle((60 * S, 42 * S, 66 * S, 96 * S), fill=CYAN)
    c.text(86, 36, main, 34, TEXT, bold=True, maxw=1450)
    c.text(86, 84, sub, 18, MUTED, maxw=1450)


def footer(c: Canvas, name: str):
    c.line((60, 862), (1540, 862), BORDER, 1.0)
    c.text(60, 870, "AP3 · 光照与纹理场景 · 原生 WebGL 2.0", 13, DIM)
    c.text(1540, 870, f"docs/diagrams/{name}", 13, DIM, anchor="rt")


def card(c: Canvas, box, heading: str, accent=CYAN, size=20):
    x0, y0, x1, y1 = box
    c.rrect(box, 16, PANEL, BORDER, 1.6)
    c.d.rectangle(((x0 + 18) * S, (y0 + 17) * S, (x0 + 22) * S, (y0 + 43) * S), fill=accent)
    c.text(x0 + 32, y0 + 14, heading, size, TEXT, bold=True, maxw=x1 - x0 - 54)
    return y0 + 52


def code_block(c: Canvas, box, lines, size=15, accent=None):
    """代码块：Latin 用 Consolas；行内 // 后面的中文注释用微软雅黑，避免方块乱码。"""
    x0, y0, x1, y1 = box
    c.rrect(box, 10, CODEBG, BORDER, 1.2)
    if accent:
        c.d.rectangle(((x0 + 10) * S, y0 * S, (x1 - 10) * S, (y0 + 2.2) * S), fill=accent)

    def split_comment(ln):
        if "//" not in ln:
            return ln, None
        pre, post = ln.split("//", 1)
        if not any(ord(ch) > 127 for ch in post):
            return ln, None
        return pre, "//" + post

    def line_width(ln, sz):
        pre, cmt = split_comment(ln)
        w = c.textlen(pre, sz, code=True)
        if cmt:
            w += c.textlen(cmt, sz * 0.97)
        return w

    size = float(size)
    avail = (x1 - x0) - 24
    while size > 8.0 and max(line_width(ln, size) for ln in lines) > avail:
        size -= 0.5
    cy = y0 + 11
    for ln in lines:
        pre, cmt = split_comment(ln)
        if cmt:
            c.text(x0 + 12, cy, pre, size, (205, 215, 226), code=True)
            c.text(x0 + 12 + c.textlen(pre, size, code=True), cy, cmt,
                   size * 0.97, (118, 172, 145))
        else:
            col = (120, 176, 148) if ln.strip().startswith("//") else (205, 215, 226)
            c.text(x0 + 12, cy, ln, size, col, code=True)
        cy += size * 1.55
    return cy


def chip(c: Canvas, box, text, color=TEXT, fill=PANEL2, border=BORDER, size=15, bold=False):
    x0, y0, x1, y1 = box
    c.rrect(box, 12, fill, border, 1.2)
    c.text((x0 + x1) / 2, (y0 + y1) / 2, text, size, color,
           bold=bold, anchor="mm", maxw=(x1 - x0) - 16)


def bullets(c: Canvas, x, y, items, size=16, color=TEXT, maxw=420,
            dotcolor=CYAN, line=1.5, gap=8):
    cy = float(y)
    for it in items:
        c.circle(x + 4, cy + size * 0.62, 3.2, fill=dotcolor)
        cy = c.para(x + 16, cy, it, size, color, maxw, line=line)
        cy += gap
    return cy


def label_value(c: Canvas, x, y, label, value, size=14, lcolor=MUTED, vcolor=TEXT,
                maxw=300, code=False):
    lw = c.textlen(label, size)
    c.text(x, y, label, size, lcolor, maxw=maxw)
    c.text(x + lw + 6, y, value, size, vcolor, code=code, maxw=max(40, maxw - lw - 6))


# ---- 图标 ----
def sun_icon(c: Canvas, cx, cy, r=30):
    for i in range(12):
        a = i * math.pi / 6.0
        c.line((cx + math.cos(a) * (r + 6), cy + math.sin(a) * (r + 6)),
               (cx + math.cos(a) * (r + 17), cy + math.sin(a) * (r + 17)), ORANGE, 2.2)
    c.circle(cx, cy, r, fill=(250, 190, 95), outline=(255, 226, 165), width=2)


def camera_icon(c: Canvas, x, y, w=86, h=58):
    c.rrect((x, y + 8, x + w, y + h), 8, (36, 52, 66), CYAN, 1.6)
    c.polygon([(x - 24, y + h * 0.32), (x, y + h * 0.22), (x, y + h * 0.78),
               (x - 24, y + h * 0.68)], fill=(36, 52, 66))
    c.circle(x + w * 0.52, y + h * 0.62, h * 0.26, fill=(14, 20, 26), outline=CYAN, width=1.6)
    c.circle(x + w * 0.52, y + h * 0.62, h * 0.10, fill=CYAN)


def cursor_icon(c: Canvas, x, y, s=18, color=WHITE):
    c.polygon([(x, y), (x, y + s * 1.35), (x + s * 0.34, y + s * 1.02),
               (x + s * 0.56, y + s * 1.5), (x + s * 0.72, y + s * 1.42),
               (x + s * 0.50, y + s * 0.96), (x + s * 0.90, y + s * 0.94)],
              fill=color, outline=(20, 24, 30), width=0.8)


def iso_cube(c: Canvas, x, y, s, top=(70, 120, 140), left=(40, 78, 96),
             right=(52, 96, 116), outline=(150, 210, 230), width=1.6):
    dx, dy = s * 0.30, -s * 0.30
    c.polygon([(x, y), (x + s, y), (x + s + dx, y + dy), (x + dx, y + dy)],
              fill=top, outline=outline, width=width)
    c.polygon([(x + s, y), (x + s + dx, y + dy), (x + s + dx, y + s + dy), (x + s, y + s)],
              fill=right, outline=outline, width=width)
    c.polygon([(x, y), (x + s, y), (x + s, y + s), (x, y + s)],
              fill=left, outline=outline, width=width)


# ----------------------------------------------------------------------------
# Phong 小球渲染（numpy，用于 Phong 示意图）
# ----------------------------------------------------------------------------
def sphere_image(px=300, mode="full", base=(0.86, 0.56, 0.32),
                 light=(-0.55, -0.62, 0.56), shininess=42.0,
                 ambient=0.10, rim=0.12):
    px = int(px)
    yy, xx = np.mgrid[0:px, 0:px].astype(np.float32)
    r = px * 0.5
    nx = (xx + 0.5 - r) / r
    ny = -(yy + 0.5 - r) / r
    r2 = nx * nx + ny * ny
    inside = r2 <= 1.0
    nz = np.sqrt(np.clip(1.0 - r2, 0.0, 1.0))
    n = np.stack([nx, ny, nz], axis=-1)
    ln = np.asarray(light, np.float32)
    ln /= np.linalg.norm(ln)
    v = np.array([0.0, 0.0, 1.0], np.float32)
    ndl = np.clip((n * ln).sum(-1), 0.0, 1.0)
    refl = 2.0 * ndl[..., None] * n - ln
    spec = np.clip((refl * v).sum(-1), 0.0, 1.0) ** shininess
    base = np.asarray(base, np.float32)[None, None, :]
    rimv = ((1.0 - nz) ** 2.4 * rim)[..., None]
    if mode == "ambient":
        col = base * 0.30 + base * rimv * 0.6
    elif mode == "diffuse":
        col = base * ndl[..., None] * 1.05
    elif mode == "specular":
        col = (np.array([0.035, 0.035, 0.045], np.float32)[None, None, :]
               + spec[..., None] * 1.15)
    else:
        col = base * (ambient + ndl[..., None]) + spec[..., None] * 0.95 + base * rimv
    rr = col * 240.0
    alpha = np.clip((1.0 - r2) * (px * 0.5) * 1.2, 0.0, 1.0)
    rgba = np.dstack([np.clip(rr, 0, 255), np.clip(alpha * 255, 0, 255)]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


# ----------------------------------------------------------------------------
# 示意图 1：UV 数据流
# ----------------------------------------------------------------------------
def diagram_uv_dataflow():
    c = Canvas()
    title(c, "UV 坐标数据流：attribute → varying 插值 → 纹理采样 → 片元颜色",
          "一个面片从几何顶点到最终像素颜色的完整链路（WebGL 2.0；片元着色器里手写 Phong 光照）")

    # ---- 左卡片：顶点属性 ----
    A = (60, 132, 510, 712)
    y = card(c, A, "① 顶点属性 attribute", CYAN)
    c.text(78, y - 4, "in vec2 aUv;", 14.5, (150, 214, 232), code=True)
    c.text(78 + c.textlen("in vec2 aUv;", 14.5, code=True) + 12, y - 4,
           "// 每个顶点自带一个 UV", 13.5, (130, 160, 175), maxw=250)

    # 立方体（等轴测）
    fx, fy, fs = 150, 262, 175
    iso_cube(c, fx, fy, fs, top=(30, 62, 78), left=(38, 76, 94), right=(28, 58, 74),
             outline=(96, 174, 200), width=1.8)
    labels = [(fx, fy + fs, "(0,0)", "lt", (fx - 6, fy + fs + 8)),
              (fx + fs, fy + fs, "(1,0)", "rt", (fx + fs + 6, fy + fs + 8)),
              (fx + fs, fy, "(1,1)", "rt", (fx + fs + 6, fy - 24)),
              (fx, fy, "(0,1)", "lt", (fx - 6, fy - 24))]
    for px, py, txt, anch, (lx, ly) in labels:
        c.dot(px, py, 4.0, YELLOW)
        c.text(lx, ly, txt, 14, YELLOW, code=True, anchor=anch,
               maxw=110)
    c.text(fx, fy + fs + 34, "立方体一个面：4 个顶点各带一个 (u, v)", 14.5, MUTED, maxw=390)

    # 展开的 UV 方形
    ux0, uy0, ux1, uy1 = 132, 492, 302, 662
    c.rect((ux0, uy0, ux1, uy1), (24, 34, 44), CYAN, 1.8)
    for i in range(1, 4):
        c.line((ux0 + (ux1 - ux0) * i / 4, uy0), (ux0 + (ux1 - ux0) * i / 4, uy1), (34, 48, 62), 1)
        c.line((ux0, uy0 + (uy1 - uy0) * i / 4), (ux1, uy0 + (uy1 - uy0) * i / 4), (34, 48, 62), 1)
    c.text(ux0 + 4, uy1 - 24, "(0,0)", 13, YELLOW, code=True)
    c.text(ux1 - 4, uy1 - 24, "(1,0)", 13, YELLOW, code=True, anchor="rt")
    c.text(ux0 + 4, uy0 + 5, "(0,1)", 13, YELLOW, code=True)
    c.text(ux1 - 4, uy0 + 5, "(1,1)", 13, YELLOW, code=True, anchor="rt")
    c.arrow([(ux0, uy1 + 18), (ux1 + 12, uy1 + 18)], ORANGE, 2.0, 9)
    c.text(ux1 + 16, uy1 + 10, "u", 16, ORANGE, bold=True)
    c.arrow([(ux0 - 18, uy1), (ux0 - 18, uy0 - 12)], ORANGE, 2.0, 9)
    c.text(ux0 - 30, uy0 - 22, "v", 16, ORANGE, bold=True)
    c.text(ux1 + 24, uy0 + 6, "展开成一张 2D 贴图坐标：\nu 向右 0→1、v 向上 0→1",
           14.5, MUTED, maxw=150)

    # ---- 中卡片：varying 插值 + 采样 ----
    B = (550, 132, 1030, 712)
    y = card(c, B, "② varying 插值 + 纹理采样", ORANGE)
    c.text(568, y - 4, "vec2 vUv = aUv;", 14.5, (245, 196, 152), code=True)
    c.text(568 + c.textlen("vec2 vUv = aUv;", 14.5, code=True) + 12, y - 4,
           "// varying 由硬件自动插值", 13.5, (170, 150, 130), maxw=250)

    try:
        thumb = Image.open(TEX_DIR / "crate_wood.png").convert("RGB")
    except Exception:
        thumb = Image.new("RGB", (512, 512), (120, 80, 45))
    tx, ty, tsz = 590, 226, 198
    c.pasted(thumb, tx, ty, tsz, tsz)
    c.rect((tx - 2, ty - 2, tx + tsz + 2, ty + tsz + 2), None, BORDER, 1.4)
    c.text(tx, ty + tsz + 8, "uTex = crate_wood.png（512×512）", 13.5, MUTED, maxw=270)
    c.para(812, 232, "硬件在三角形内部对 vUv 做线性插值：相邻片元的 UV 只差一点点，采样出的颜色平滑过渡。",
           15, MUTED, maxw=200, line=1.55)

    # 双线性采样示意
    gx, gy, cell = 590, 484, 38
    cols = [(0.62, 0.43, 0.27), (0.56, 0.38, 0.23), (0.66, 0.47, 0.30), (0.52, 0.35, 0.21)]
    for j in range(4):
        for i in range(4):
            col = cols[(i * 2 + j * 3 + 1) % 4]
            c.rect((gx + i * cell, gy + j * cell, gx + (i + 1) * cell, gy + (j + 1) * cell),
                   tuple(int(v * 255) for v in col), (38, 48, 60), 1)
    hi = [(2, 1), (3, 1), (2, 2), (3, 2)]
    for i, j in hi:
        c.rect((gx + i * cell, gy + j * cell, gx + (i + 1) * cell, gy + (j + 1) * cell),
               None, YELLOW, 2.2)
    px = gx + 2.62 * cell
    py = gy + 1.58 * cell
    for i, j in hi:
        c.line((px, py), (gx + (i + 0.5) * cell, gy + (j + 0.5) * cell), (250, 204, 21), 1.2)
    c.dot(px, py, 5.0, YELLOW)
    c.text(gx, gy + 4 * cell + 8, "双线性采样 = 4 个最近纹素按距离加权", 13.5, MUTED, maxw=220)
    code_block(c, (824, 470, 1012, 576),
               ["vec3 diffuse =", "  texture(uTex, vUv).rgb;"], 14, ORANGE)
    c.para(824, 590, "采样结果就是该片元的 diffuse 颜色，接着进入 Phong 光照计算。",
           14.5, MUTED, maxw=190, line=1.55)
    c.text(568, 668, "varying 不是数值本身，而是“每个片元插值后的一份副本”。", 14.5, DIM, maxw=444)

    # ---- 右卡片：片元颜色 ----
    C = (1070, 132, 1540, 712)
    y = card(c, C, "③ 每个片元的颜色", PURPLE)
    c.text(1088, y - 4, "vec3 diffuse = texture(uTex, vUv).rgb;", 14.5,
           (200, 188, 245), code=True, maxw=430)

    P0, P1, P2 = (1150, 452), (1452, 452), (1301, 246)
    c.polygon([P0, P1, P2], (38, 30, 56), PURPLE, 2.0)
    # 顶点 UV：P0=(0,0), P1=(1,0), P2=(1,1)
    c.text(P0[0] - 6, P0[1] + 6, "(0,0)", 13, YELLOW, code=True)
    c.text(P1[0] + 6, P1[1] + 6, "(1,0)", 13, YELLOW, code=True, anchor="rt")
    c.text(P2[0] + 10, P2[1] - 20, "(1,1)", 13, YELLOW, code=True)
    frags = [(0.65, 0.17, 0.18, "rt"), (0.25, 0.53, 0.22, "lt"),
             (0.35, 0.10, 0.55, "lt"), (0.12, 0.13, 0.75, "lt")]
    for a, b, cc_, side in frags:
        uu = b + cc_
        vv = cc_
        fx = a * P0[0] + b * P1[0] + cc_ * P2[0]
        fy = a * P0[1] + b * P1[1] + cc_ * P2[1]
        c.dot(fx, fy, 4.0, WHITE)
        if side == "rt":
            c.text(fx - 8, fy - 9, f"({uu:.2f},{vv:.2f})", 11.5, (200, 214, 228),
                   code=True, anchor="rt")
        else:
            c.text(fx + 8, fy - 9, f"({uu:.2f},{vv:.2f})", 11.5, (200, 214, 228), code=True)
    c.text(1088, 470, "硬件对 UV 线性插值 → 每个片元得到自己的 vUv", 14.5, MUTED, maxw=430)
    code_block(c, (1088, 498, 1522, 642), [
        "vec3 amb  = uKa * uAmbient;",
        "vec3 diff = uKd * diffuse * max(dot(N, L), 0.0);",
        "vec3 spec = uKs * pow(max(dot(R, V), 0.0), uShin);",
        "FragColor = vec4(amb + diff + spec, 1.0);",
    ], 13.2, PURPLE)
    c.text(1088, 658, "对每个片元独立执行一次，所以叫 per-fragment 光照。", 13.5, DIM, maxw=434)

    # ---- 底部流程条 ----
    strip = (60, 728, 1540, 850)
    c.rrect(strip, 16, PANEL, BORDER, 1.6)
    c.text(84, 740, "一次纹理采样在管线里的位置：", 16, MUTED, bold=True)
    items = [("① aUv", "attribute"), ("② vUv", "varying 插值"), ("③ texture(uTex, vUv)", "采样"),
             ("④ diffuse", "颜色"), ("⑤ Phong", "光照计算"), ("⑥ FragColor", "输出片元")]
    n = len(items)
    gap = 18
    bw = (1460 - gap * (n - 1)) / n
    by0, by1 = 782, 832
    for i, (h1, h2) in enumerate(items):
        x0 = 70 + i * (bw + gap)
        c.rrect((x0, by0, x0 + bw, by1), 12, PANEL2, BORDER, 1.2)
        c.text(x0 + bw / 2, by0 + 10, h1, 14.5, TEXT, bold=True, anchor="mt", maxw=bw - 14)
        c.text(x0 + bw / 2, by0 + 30, h2, 12.5, MUTED, anchor="mt", maxw=bw - 14)
    for i in range(n - 1):
        x0 = 70 + i * (bw + gap) + bw
        c.arrow([(x0 + 2, (by0 + by1) / 2), (x0 + gap - 2, (by0 + by1) / 2)], ORANGE, 1.8, 7)

    c.save("uv-dataflow.png")


# ----------------------------------------------------------------------------
# 示意图 2：阴影两遍渲染
# ----------------------------------------------------------------------------
def diagram_shadow_two_pass():
    c = Canvas()
    title(c, "阴影贴图两遍渲染：先从光源写深度，再从相机读回比较",
          "Pass 1 用光源正交矩阵 lightVP 渲染深度到 FBO；Pass 2 把片元投影回光源空间做深度比较")

    # ---- Pass 1 ----
    P1 = (60, 128, 1540, 424)
    y = card(c, P1, "Pass 1 · 光源视角：只写深度", ORANGE)
    c.text(78, y - 6, "方向光（平行光）→ 正交投影 lightView · lightProj = lightVP → 深度纹理",
           14.5, MUTED, maxw=520)

    sun_icon(c, 152, 290, 30)
    c.text(152, 326, "方向光 L", 14, MUTED, anchor="mt")

    c.arrow([(196, 290), (270, 290)], ORANGE, 2.2, 10)

    # 正交视锥
    fx0, fy0, fw, fh = 284, 236, 186, 132
    ox, oy = 62, -28
    c.rect((fx0, fy0, fx0 + fw, fy0 + fh), (44, 34, 24), ORANGE, 1.6)
    c.rect((fx0 + ox, fy0 + oy, fx0 + ox + fw, fy0 + oy + fh), None, (150, 100, 55), 1.2)
    for ix, iy in ((0, 0), (1, 0), (0, 1), (1, 1)):
        c.line((fx0 + ix * fw, fy0 + iy * fh),
               (fx0 + ox + ix * fw, fy0 + oy + iy * fh), (150, 100, 55), 1.2)
    for k in range(1, 4):
        yy = fy0 + fh * k / 4
        c.line((fx0 + 8, yy), (fx0 + fw - 8, yy), (110, 76, 44), 1)
    c.text(fx0, fy0 + fh + 12, "正交视锥（方向光无透视）", 14, MUTED, maxw=250)
    c.text(fx0, fy0 + fh + 32, "lightVP = lightProj · lightView", 13,
           (214, 168, 120), code=True, maxw=260)

    c.arrow([(548, 290), (612, 290)], ORANGE, 2.2, 10)

    # 深度纹理
    dx0, dy0, dsz = 624, 202, 176
    depth = np.linspace(1.0, 0.0, dsz, dtype=np.float32)[:, None]
    darr = np.repeat((depth * 0.55 + 0.12) * 255.0, dsz, axis=1)
    dimg = Image.fromarray(np.dstack([darr, darr * 0.96, darr * 1.0]).astype(np.uint8), "RGB")
    dd = ImageDraw.Draw(dimg)
    dd.rectangle((dsz * 0.30, dsz * 0.30, dsz * 0.72, dsz * 0.80), fill=(235, 238, 240))
    dd.rectangle((dsz * 0.18, dsz * 0.80, dsz * 0.86, dsz * 0.88), fill=(205, 210, 215))
    c.pasted(dimg, dx0, dy0, dsz, dsz)
    c.rect((dx0 - 2, dy0 - 2, dx0 + dsz + 2, dy0 + dsz + 2), None, BORDER, 1.4)
    c.text(dx0 + dsz / 2, dy0 + dsz + 10, "深度纹理 shadowMap", 14, TEXT, anchor="mt", bold=True)
    c.text(dx0 + dsz / 2, dy0 + dsz + 30, "2048×2048  DEPTH_COMPONENT24", 12.5, MUTED,
           anchor="mt", maxw=300)

    c.arrow([(812, 290), (868, 290)], ORANGE, 2.2, 10)
    code_block(c, (878, 196, 1522, 404), [
        "// 绑定深度 FBO，绘制所有投影物体",
        "gl.bindFramebuffer(gl.FRAMEBUFFER, depthFBO);",
        "gl.clear(gl.DEPTH_BUFFER_BIT);",
        "gl.useProgram(depthProgram);   // gl_Position = lightVP * model * pos",
        "// 片段着色器只写深度，颜色附件不参与",
        "void main() { gl_FragDepth = gl_FragCoord.z; }",
    ], 13.5, ORANGE)

    # 从深度纹理到 Pass 2 的箭头
    c.dashed([(1180, 424), (1180, 456)], MUTED, 1.6, 8, 6)
    c.text(1200, 428, "shadowMap 供 Pass 2 采样", 13, MUTED, maxw=220)

    # ---- Pass 2 ----
    P2 = (60, 456, 1540, 744)
    y = card(c, P2, "Pass 2 · 相机视角：把片元投影回光源空间比较深度", CYAN)
    c.para(78, y - 6, "相机渲染主 Pass；每个片元读取 shadowMap 判断是否被遮挡，PCF 3×3 软化边缘。",
           14.5, MUTED, maxw=520, line=1.5)

    camera_icon(c, 112, 574, 86, 58)
    c.text(112, 646, "相机 camera", 13.5, MUTED, maxw=110)
    c.arrow([(178, 608), (240, 608)], CYAN, 2.0, 9)

    # 场景与阴影
    c.line((252, 668), (540, 668), (74, 92, 112), 2.0)
    iso_cube(c, 298, 566, 74, top=(46, 78, 90), left=(40, 64, 78), right=(34, 54, 66),
             outline=(120, 180, 200), width=1.5)
    c.polygon([(300, 668), (372, 668), (430, 646), (358, 646)], (24, 30, 38), (48, 58, 72), 1.0)
    c.text(252, 678, "主 Pass：Phong + 纹理 + 阴影查找", 13, MUTED, maxw=300)
    c.arrow([(548, 608), (612, 608)], CYAN, 2.0, 9)

    code_block(c, (622, 552, 1152, 736), [
        "vec4 lightClip = uLightVP * vec4(vWorldPos, 1.0);",
        "vec3 proj = lightClip.xyz / lightClip.w * 0.5 + 0.5;",
        "// bias 防自阴影（shadow acne）",
        "float bias = max(0.0015 * (1.0 - dot(N, L)), 0.0005);",
        "float shadowDepth = texture(uShadowMap, proj.xy).r;",
        "float shadow = (proj.z - bias > shadowDepth) ? 0.0 : 1.0;",
        "// 被遮挡的片元只剩环境光",
        "vec3 color = ambient + shadow * (diffuse + specular);",
    ], 12.8, CYAN)

    # PCF 卡
    pcx, pcy = 1318, 560
    c.text(1180, 514, "PCF 3×3", 17, TEXT, bold=True)
    c.text(1180, 538, "9 次采样取平均，软化\n锯齿边缘", 13.5, MUTED, maxw=150)
    for j in range(3):
        for i in range(3):
            c.rect((pcx + i * 26, pcy + j * 26, pcx + i * 26 + 24, pcy + j * 26 + 24),
                   (26, 36, 46), (80, 140, 160), 1.0)
    c.text(pcx + 39, pcy + 88, "Σ / 9", 13.5, MUTED, anchor="mt", maxw=120)
    c.text(1300, 662, "shadow = Σ 9 samples / 9", 13, MUTED, maxw=210)

    c.text(78, 770, "深度比较失败（片元比 shadowMap 更远）→ 该片元被遮挡 → 只有环境光；bias 沿光线方向偏移比较阈值，消除自阴影。",
           15, (250, 190, 120), maxw=1450)

    c.save("shadow-two-pass.png")


# ----------------------------------------------------------------------------
# 示意图 3：Phong 三分量
# ----------------------------------------------------------------------------
def diagram_phong_components():
    c = Canvas()
    title(c, "Phong 光照三分量：环境光 + 漫反射 + 镜面高光",
          "全部在片元着色器中逐像素计算（per-fragment Phong）：N / L / V / R 每个片元各算一次")

    # ---- 左卡片：主光路 ----
    A = (60, 128, 556, 726)
    y = card(c, A, "主光路：N / L / V / R", CYAN)
    c.text(78, y - 6, "球面上的一个片元 P 的四个方向", 14.5, MUTED, maxw=460)
    big = sphere_image(340 * S, "full", base=(0.88, 0.55, 0.30),
                       light=(-0.6, 0.65, 0.55), shininess=48, rim=0.10)
    sx, sy, ss = 138, 218, 340
    c.pasted(big, sx, sy, ss, ss)
    # 球心与 P 点
    ccx, ccy = sx + ss / 2, sy + ss / 2
    R = ss / 2
    ang = math.radians(-34)
    px = ccx + R * 0.82 * math.cos(ang)
    py = ccy + R * 0.82 * math.sin(ang)
    c.dot(px, py, 4.5, WHITE)
    c.text(px + 8, py + 4, "P", 15, WHITE, bold=True)

    def arrow_dir(p0, dx, dy, color, label, length=82):
        n = math.hypot(dx, dy)
        ux, uy = dx / n, dy / n
        c.arrow([p0, (p0[0] + ux * length, p0[1] + uy * length)], color, 2.4, 10)
        c.text(p0[0] + ux * (length + 10), p0[1] + uy * (length + 10) - 9, label,
               16, color, bold=True)

    arrow_dir((px, py), 0.90, -0.75, CYAN, "N", 76)
    arrow_dir((px, py), -0.95, -0.55, ORANGE, "L", 88)
    arrow_dir((px, py), -0.55, 0.85, GREEN, "V", 78)
    arrow_dir((px, py), 0.88, 0.48, PURPLE, "R", 84)

    c.text(78, 574, "N 表面法线　L 光源方向", 14, MUTED, maxw=440)
    c.text(78, 596, "V 视线方向　R 反射方向（R = reflect(-L, N)）", 14, MUTED, maxw=440)
    c.text(78, 640, "片元着色器逐像素计算（per-fragment）", 15, TEXT, bold=True, maxw=440)
    c.text(78, 666, "vNormal / vWorldPos 由顶点插值得到，再归一化使用", 13.5, DIM, maxw=440)

    # ---- 中卡片：四个小球 ----
    mids = [
        (600, 128, 810, 372, "环境光 I_a", CYAN, "ambient", "均匀暗：与法线无关"),
        (844, 128, 1054, 372, "漫反射 I_d", ORANGE, "diffuse", "亮暗过渡：由 N·L 决定"),
        (600, 392, 810, 636, "镜面高光 I_s", PURPLE, "specular", "一小块高光：由 R·V 决定"),
        (844, 392, 1054, 636, "三项合成 I", GREEN, "full", "环境 + 漫反射 + 镜面"),
    ]
    for (x0, y0, x1, y1, head, accent, mode, desc) in mids:
        c.rrect((x0, y0, x1, y1), 14, PANEL, BORDER, 1.4)
        c.d.rectangle(((x0 + 16) * S, (y0 + 16) * S, (x0 + 20) * S, (y0 + 38) * S), fill=accent)
        c.text(x0 + 28, y0 + 13, head, 16.5, TEXT, bold=True, maxw=x1 - x0 - 40)
        simg = sphere_image(128 * S, mode, base=(0.88, 0.56, 0.32),
                            light=(-0.6, 0.65, 0.55), ambient=0.10)
        c.pasted(simg, x0 + (x1 - x0) / 2 - 64, y0 + 40, 128, 128)
        c.text((x0 + x1) / 2, y1 - 44, desc, 12.8, MUTED, anchor="mt", maxw=x1 - x0 - 24)

    c.text(600, 648, "每个小球只打开对应分量的结果，可以直观看到三项各自的贡献。",
           13.5, DIM, maxw=454)
    c.text(600, 672, "实际渲染时三项相加（见右侧公式）。", 13.5, DIM, maxw=454)

    # ---- 右卡片：公式 ----
    B = (1090, 128, 1540, 726)
    y = card(c, B, "三项相加 = Phong 光照模型", GREEN)
    blocks = [
        ("环境光 Ambient", CYAN, "I_a = k_a · L_a",
         "常数基底：即使背光也保留一点亮度，避免全黑。"),
        ("漫反射 Diffuse", ORANGE, "I_d = k_d · max(N·L, 0) · L_d",
         "N·L 决定明暗过渡；与视线方向无关。"),
        ("镜面高光 Specular", PURPLE, "I_s = k_s · max(R·V, 0)^n · L_s",
         "高光位置由反射方向 R 决定；n 越大高光越锐利。"),
        ("合成", GREEN, "I = I_a + I_d + I_s",
         "逐片元计算后写入 FragColor，再经 gamma / 色调处理。"),
    ]
    by = 196
    for name, accent, formula, desc in blocks:
        c.rrect((1118, by, 1512, by + 108), 12, PANEL2, BORDER, 1.2)
        c.d.rectangle((1118 * S, by * S, (1122) * S, (by + 108) * S), fill=accent)
        c.text(1136, by + 10, name, 16, TEXT, bold=True, maxw=360)
        c.text(1136, by + 36, formula, 15.5, accent, code=True, maxw=370)
        c.para(1136, by + 62, desc, 12.8, MUTED, maxw=360, line=1.4)
        by += 122

    c.text(78, 770, "片元着色器手写 Phong：N / L / V / R 在每个片元上重新计算，比逐顶点 Gouraud 更平滑；无高光贴图、无 IBL。",
           15, (150, 220, 200), maxw=1450)

    c.save("phong-components.png")


# ----------------------------------------------------------------------------
# 示意图 4：颜色编码拾取
# ----------------------------------------------------------------------------
def diagram_picking_flow():
    c = Canvas()
    title(c, "颜色编码拾取：ID 渲染进离屏 FBO → gl.readPixels → 反解 ID 并选中",
          "鼠标点击时多跑一遍「用唯一 ID 颜色绘制所有物体」的 Pass，读回 1 个像素即可知道点到了谁")

    # ---- 顶部六步流程 ----
    steps = [
        ("① 鼠标点击", "屏幕坐标 (x, y)"),
        ("② 拾取 Pass", "离屏 FBO：每个物体\n渲染成唯一 ID 颜色"),
        ("③ gl.readPixels", "读该像素 1×1\nUint8Array(4)"),
        ("④ 反解 ID", "id = r + g·256 + b·65536"),
        ("⑤ 选中物体", "id → 物体表\n面板切换到该物体"),
        ("⑥ 高亮反馈", "描边 / 边缘光\n刷新选中面板"),
    ]
    gap, n = 22, len(steps)
    bw = (1460 - gap * (n - 1)) / n
    by0, by1 = 150, 296
    for i, (h1, h2) in enumerate(steps):
        x0 = 70 + i * (bw + gap)
        c.rrect((x0, by0, x0 + bw, by1), 14, PANEL, BORDER, 1.4)
        c.text(x0 + 16, by0 + 12, h1, 16.5, TEXT, bold=True, maxw=bw - 30)
        c.para(x0 + 16, by0 + 42, h2, 12.8, MUTED, maxw=bw - 30, line=1.5)
    for i in range(n - 1):
        x0 = 70 + i * (bw + gap) + bw
        c.arrow([(x0 + 3, (by0 + by1) / 2), (x0 + gap - 3, (by0 + by1) / 2)], ORANGE, 2.0, 8)

    # ---- 左下：FBO 里的 ID 颜色 ----
    A = (60, 322, 612, 844)
    y = card(c, A, "离屏 FBO 里的 ID 颜色（示意）", RED)
    c.text(78, y - 4, "真实 ID 颜色非常暗（如 (1,0,0)），这里为便于观察提高了亮度。",
           13, DIM, maxw=514)

    # 三个立方体，ID 色（真实编码颜色极暗，这里放亮显示）
    cubes = [(190, 452, (210, 62, 62), (255, 120, 120), "id = 1", "(1, 0, 0)"),
             (330, 452, (238, 88, 88), (255, 150, 150), "id = 2", "(2, 0, 0)"),
             (470, 452, (215, 190, 55), (250, 230, 120), "id = 257", "(1, 1, 0)")]
    # 注意：示意图里用放大后的近似色；下面解码卡用真实编码值
    for (bx, by, c1, c2, lab, rgb) in cubes:
        c.polygon([(bx, by), (bx + 74, by), (bx + 96, by - 22), (bx + 22, by - 22)],
                  fill=tuple(min(255, int(v * 0.8)) for v in c1), outline=c2, width=1.6)
        c.polygon([(bx + 74, by), (bx + 96, by - 22), (bx + 96, by + 52), (bx + 74, by + 74)],
                  fill=tuple(int(v * 0.65) for v in c1), outline=c2, width=1.6)
        c.rect((bx, by, bx + 74, by + 74), c1, c2, 1.6)
        c.text(bx + 37, by + 78, lab, 13.5, TEXT, bold=True, anchor="mt", maxw=90)
        c.text(bx + 37, by + 96, rgb, 12, MUTED, anchor="mt", code=True, maxw=100)
    cursor_icon(c, 366, 486, 20, WHITE)
    c.text(300, 404, "鼠标点在这里", 12.5, MUTED, maxw=150)

    code_block(c, (78, 578, 594, 826), [
        "// 拾取 Pass 片段着色器：把物体 id 编码成颜色",
        "vec3 idColor(float id) {",
        "  return vec3(mod(id, 256.0),",
        "              mod(floor(id / 256.0), 256.0),",
        "              floor(id / 65536.0)) / 255.0;",
        "}",
        "// 渲染完后再读回像素：",
        "gl.readPixels(x, y, 1, 1, gl.RGBA,",
        "              gl.UNSIGNED_BYTE, buf);",
    ], 12.3, RED)

    # ---- 中上：ID 编码 ----
    B = (646, 322, 1122, 592)
    y = card(c, B, "ID 与颜色编码", ORANGE)
    c.text(664, y - 4, "id = r + g·256 + b·65536", 18, ORANGE, code=True, maxw=430)
    c.text(664, y + 30, "每个颜色分量 0~255；三通道可编码 2^24 个物体。", 12.8, MUTED, maxw=430)
    c.text(664, y + 52, "提示：(0,1,0) 只点亮绿通道 → 解码为 256；257 = 1 + 0 + 256。",
           12.2, DIM, maxw=430)
    swatches = [((1, 0, 0), 1), ((2, 0, 0), 2), ((1, 1, 0), 257)]
    sy = 456
    for (rgbv, ident) in swatches:
        disp = tuple(min(255, v * 90) for v in rgbv)
        c.rect((666, sy, 706, sy + 36), disp, (200, 210, 220), 1.2)
        c.text(720, sy + 6, f"色 ({rgbv[0]}, {rgbv[1]}, {rgbv[2]})", 14, TEXT, maxw=190)
        c.text(920, sy + 6, f"→ id = {ident}", 14, YELLOW, bold=True, maxw=190)
        sy += 44

    # ---- 中下：readPixels 结果 ----
    C = (646, 606, 1122, 844)
    y = card(c, C, "readPixels 读回的结果", YELLOW)
    c.rect((668, 672, 718, 722), (255, 255, 0), (220, 220, 220), 1.4)
    c.text(690, 687, "1 px", 11.5, (30, 30, 30), anchor="mm")
    c.text(736, 676, "Uint8Array = [r, g, b, a]", 13.5, TEXT, code=True, maxw=340)
    c.text(736, 698, "= [1, 1, 0, 255]", 13.5, YELLOW, code=True, maxw=340)
    c.text(736, 720, "→ id = 1 + 1·256 + 0 = 257", 13.5, TEXT, code=True, maxw=340)
    c.text(668, 758, "id 257 → 物体表查表 → 木箱（crate）；面板切换到它的材质参数。",
           13.2, MUTED, maxw=430)
    c.text(668, 792, "拾取 Pass 只在鼠标点击时执行，不进入每帧渲染。", 13.2, DIM, maxw=430)

    # ---- 右侧：选中反馈 ----
    D = (1156, 322, 1540, 844)
    y = card(c, D, "选中后的反馈", GREEN)
    # 高亮描边示意
    iso_cube(c, 1226, 456, 92, top=(42, 76, 88), left=(36, 62, 74), right=(30, 52, 62),
             outline=GREEN, width=2.0)
    c.rrect((1204, 418, 1352, 566), 8, None, GREEN, 2.2)
    c.text(1356, 452, "描边 / 边缘光", 14.5, GREEN, bold=True, maxw=180)
    c.text(1356, 474, "让选中物体从\n场景中凸显", 12.5, MUTED, maxw=160)

    # 面板示意
    c.text(1180, 586, "参数面板", 15, TEXT, bold=True)
    rows = [("木箱 crate", True), ("台座 marble", False), ("地面 floor", False)]
    ry = 616
    for name, sel in rows:
        c.rrect((1180, ry, 1516, ry + 40), 8, (30, 48, 48) if sel else PANEL2,
                GREEN if sel else BORDER, 1.4)
        c.text(1194, ry + 10, name, 14, TEXT if sel else MUTED, maxw=250)
        if sel:
            c.circle(1490, ry + 20, 6, fill=GREEN)
        ry += 48
    c.text(1180, 772, "选中状态与高亮由同一份 UI 状态驱动。", 12.8, DIM, maxw=340)

    c.save("picking-flow.png")


# ----------------------------------------------------------------------------
# 示意图 5：总体渲染管线
# ----------------------------------------------------------------------------
def diagram_pipeline_overview():
    c = Canvas()
    title(c, "渲染管线总览：场景配置 → 阴影 Pass → 主 Pass → 透明 Pass → 拾取 Pass → 画布",
          "每个 Pass 各有一段 render loop，共享同一套场景矩阵与资源；场景 / 着色器 / UI 分文件组织")

    # ---- 资源行 ----
    assets = [
        (60, 126, 400, 196, "位图纹理  assets/textures/*.png", "木板 / 木箱 / 灰泥 / 棋盘 / 大理石 + 法线"),
        (420, 126, 760, 196, "立方体贴图  assets/cubemap/*.png", "黄昏天空盒六面（无缝）"),
        (780, 126, 1120, 196, "深度纹理  shadowMap", "Pass 1 生成，Pass 2 采样"),
        (1140, 126, 1540, 196, "场景数据  src/config.js", "相机 / 光源 / 材质 / 物体列表"),
    ]
    for (x0, y0, x1, y1, h1, h2) in assets:
        c.rrect((x0, y0, x1, y1), 12, PANEL2, BORDER, 1.2)
        c.text(x0 + 14, y0 + 12, h1, 14.5, TEXT, bold=True, maxw=x1 - x0 - 28)
        c.text(x0 + 14, y0 + 36, h2, 12, MUTED, maxw=x1 - x0 - 28)

    # ---- 主流程 ----
    boxes = [
        ("① 场景配置", "src/config.js", ["相机、光源、材质", "物体列表、变换"], "配置对象", CYAN),
        ("② 阴影 Pass", "src/shadow.js", ["方向光正交 lightVP", "2048² 深度 FBO"], "shadowMap", ORANGE),
        ("③ 主 Pass", "src/renderer.js", ["Phong 光照", "位图纹理 / cubemap 反射", "阴影查找 / 法线贴图"], "颜色 + 深度", PURPLE),
        ("④ 透明物体 Pass", "src/renderer.js", ["混合与排序", "关闭深度写入"], "合成颜色", GREEN),
        ("⑤ 拾取 Pass（按需）", "src/picking.js", ["鼠标点击时执行", "ID 颜色 FBO → readPixels"], "选中 id", YELLOW),
        ("⑥ 画布", "canvas / index.html", ["默认帧缓冲", "呈现到屏幕"], "屏幕图像", (180, 190, 205)),
    ]
    gap = 20
    n = len(boxes)
    bw = (1468 - gap * (n - 1)) / n
    by0, by1 = 286, 474
    for i, (h1, h2, lines, out, accent) in enumerate(boxes):
        x0 = 60 + i * (bw + gap)
        c.rrect((x0, by0, x0 + bw, by1), 14, PANEL, BORDER, 1.5)
        c.d.rectangle(((x0 + 14) * S, (by0 + 14) * S, (x0 + 18) * S, (by0 + 40) * S), fill=accent)
        c.text(x0 + 26, by0 + 12, h1, 16, TEXT, bold=True, maxw=bw - 40)
        c.text(x0 + 26, by0 + 38, h2, 12.5, accent, code=True, maxw=bw - 40)
        yy = by0 + 66
        for ln in lines:
            c.dot(x0 + 25, yy + 7, 2.4, accent)
            yy = c.para(x0 + 33, yy, ln, 12.3, MUTED, bw - 46, line=1.45) + 2
        c.text(x0 + 26, by1 - 32, "输出：" + out, 11.5, DIM, maxw=bw - 40)
    for i in range(n - 1):
        x0 = 60 + i * (bw + gap) + bw
        c.arrow([(x0 + 2, (by0 + by1) / 2), (x0 + gap - 2, (by0 + by1) / 2)], ORANGE, 2.2, 8)

    # 资源与 Pass 的关系说明（避免跨行虚线箭头造成视觉混乱）
    c.text(W / 2, 210,
           "以下各 Pass 共享上面列出的资产与场景数据；位图纹理 / cubemap 在主 Pass 采样，"
           "shadowMap 由阴影 Pass 生成后供主 Pass 读取。",
           13, MUTED, anchor="mt", maxw=1420)

    # ---- 说明卡 ----
    Info = (60, 520, 1540, 844)
    c.rrect(Info, 16, PANEL, BORDER, 1.6)
    c.text(84, 536, "Pass 顺序与依赖", 17, TEXT, bold=True)
    bullets(c, 84, 574, [
        "阴影 Pass 先执行：生成 shadowMap，主 Pass 里采样做深度比较；",
        "主 Pass：Phong 光照 + 位图纹理 + cubemap 环境反射 + 阴影查找 + 法线贴图；",
        "透明物体 Pass：最后绘制，开启混合并关闭深度写入；",
        "拾取 Pass：只在鼠标点击时执行（按需），渲染 ID 颜色后 readPixels；",
        "所有 Pass 共用同一份相机 view/projection 与光源 lightVP 矩阵。",
    ], 13.5, MUTED, maxw=690, dotcolor=PURPLE, gap=6)

    c.text(820, 536, "模块划分（场景 / 着色器 / UI 分文件）", 17, TEXT, bold=True)
    rows = [
        ("src/config.js", "场景参数：相机、光源、材质、物体"),
        ("src/shadow.js", "阴影 Pass、深度 FBO、lightVP"),
        ("src/renderer.js", "主 Pass / 透明 Pass 的调度与状态"),
        ("src/shaders.js", "全部 GLSL：Phong / 阴影 / 天空盒 / 拾取"),
        ("src/picking.js", "颜色编码拾取与 readPixels"),
        ("src/ui.js", "参数面板、物体选中态与高亮"),
    ]
    ry = 578
    for fn, desc in rows:
        c.text(820, ry, fn, 13, CYAN, code=True, maxw=180)
        c.text(1012, ry, desc, 13, MUTED, maxw=520)
        ry += 38

    c.save("pipeline-overview.png")


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"AP3 原理示意图生成器（{W}×{H}，{S}× 超采样）")
    print(f"输出目录：{OUT_DIR}\n")
    jobs = [("uv-dataflow.png", diagram_uv_dataflow),
            ("shadow-two-pass.png", diagram_shadow_two_pass),
            ("phong-components.png", diagram_phong_components),
            ("picking-flow.png", diagram_picking_flow),
            ("pipeline-overview.png", diagram_pipeline_overview)]
    for name, fn in jobs:
        print(f"绘制 {name} ...")
        fn()
    print("\n自检清单：")
    total = 0
    for name, _ in jobs:
        path = OUT_DIR / name
        with Image.open(path) as im:
            im.load()
            w, h = im.size
            mode = im.mode
        kb = path.stat().st_size / 1024.0
        total += path.stat().st_size
        ok = (w == W and h == H and mode == "RGB" and kb > 10)
        print(f"  {name:26s} {w}x{h}  {mode}  {kb:7.1f} KB  "
              f"{'OK' if ok else '异常'}")
    print(f"  合计 {total / 1024.0 / 1024.0:.2f} MB（5 张）")
    print("\n提示：生成后请人工检查中文是否清晰、元素是否重叠。")


if __name__ == "__main__":
    main()

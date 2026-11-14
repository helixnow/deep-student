#!/usr/bin/env python3
"""第一幕用户消息里的两张「错题照片」：程序渲染的手机俯拍作业照（手写解题 + 红笔批改）。

只依赖 Pillow；手写字体用 macOS 自带的手札体（Hannotate，index 0 带 ξ ∈ φ ∴ ∥ ≠，没有 ∃）。
所有随机都来自固定种子，重跑结果一致。输出 video/src/assets/photos/{mvt,aux-fn}.webp（不用 aux.webp：AUX 是 Windows 保留设备名，会导致检出失败）。
"""
import glob
import math
import os
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'assets', 'photos')
S = 1600  # 工作画布（正方形），最后缩到 SIZE
SIZE = 720


def font_path(name):
    hits = glob.glob(f'/System/Library/AssetsV2/**/{name}', recursive=True)
    if not hits:
        raise SystemExit(f'找不到字体 {name}（系统设置 → 字体里下载「手札体」）')
    return hits[0]


HAND = font_path('Hannotate.ttc')


def hand(size, index=0):
    return ImageFont.truetype(HAND, size, index=index)


def noise_layer(w, h, amp, seed, blur=0.0):
    rnd = random.Random(seed)
    im = Image.new('L', (w, h))
    im.putdata([128 + int((rnd.random() - 0.5) * 2 * amp) for _ in range(w * h)])
    return im.filter(ImageFilter.GaussianBlur(blur)) if blur else im


def paper(w, h, seed, ruled=64, margin=True):
    base = Image.new('RGB', (w, h), (247, 245, 238))
    grain = noise_layer(w // 2, h // 2, 10, seed, 0.8).resize((w, h))
    base = ImageChops.add(base, Image.merge('RGB', [grain] * 3), scale=1.0, offset=-128)
    d = ImageDraw.Draw(base)
    for y in range(170, h - 40, ruled):
        d.line([(40, y), (w - 40, y)], fill=(186, 203, 226), width=2)
    if margin:
        d.line([(132, 40), (132, h - 40)], fill=(228, 160, 160), width=2)
    return base


def write(layer, x, y, text, size, color, seed, slant=0.0):
    """逐字落笔：每个字轻微旋转、上下浮动、大小与字距各有出入，墨色深浅不一。"""
    rnd = random.Random(seed)
    f = hand(size)
    for ch in text:
        if ch == ' ':
            x += size * (0.32 + rnd.random() * 0.06)
            continue
        s = size * (0.95 + rnd.random() * 0.1)
        fc = hand(int(s))
        tile = Image.new('RGBA', (int(s * 2), int(s * 2)), (0, 0, 0, 0))
        alpha = int(255 * (0.82 + rnd.random() * 0.18))
        ImageDraw.Draw(tile).text((s * 0.5, s * 0.35), ch, font=fc, fill=color + (alpha,))
        tile = tile.rotate(slant + (rnd.random() - 0.5) * 6, resample=Image.BICUBIC)
        dy = (rnd.random() - 0.5) * 5
        layer.alpha_composite(tile, (int(x - s * 0.5), int(y - s * 0.35 + dy)))
        x += f.getlength(ch) * (s / size) * (0.97 + rnd.random() * 0.06) + 1.5
    return x


def pen_path(d, pts, color, width, seed, passes=2):
    rnd = random.Random(seed)
    for p in range(passes):
        jit = [(x + (rnd.random() - 0.5) * 3, y + (rnd.random() - 0.5) * 3) for x, y in pts]
        d.line(jit, fill=color, width=width - p, joint='curve')


def ellipse(d, cx, cy, rx, ry, color, seed, width=6, tilt=-0.1):
    rnd = random.Random(seed)
    start = rnd.random() * math.pi
    pts = []
    for i in range(70):
        a = start + i / 60 * 2 * math.pi  # 多画一截：笔圈收尾总会交叉
        r = 1 + (rnd.random() - 0.5) * 0.05
        x, y = math.cos(a) * rx * r, math.sin(a) * ry * r
        pts.append((cx + x * math.cos(tilt) - y * math.sin(tilt), cy + x * math.sin(tilt) + y * math.cos(tilt)))
    pen_path(d, pts, color, width, seed)


def cross(d, cx, cy, r, color, seed):
    pen_path(d, [(cx - r, cy - r), (cx + r * 0.9, cy + r)], color, 7, seed)
    pen_path(d, [(cx + r, cy - r * 0.9), (cx - r * 0.8, cy + r)], color, 7, seed + 1)


def check(d, x, y, r, color, seed):
    pen_path(d, [(x - r, y), (x - r * 0.25, y + r * 0.8), (x + r * 1.3, y - r * 1.1)], color, 7, seed)


INK = (28, 42, 112)
RED = (206, 38, 42)


def sheet_mvt():
    w, h = 1300, 1240
    base = paper(w, h, 11)
    ink = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    red = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    rd = ImageDraw.Draw(red)
    write(ink, 160, 92, '例3  拉格朗日中值定理', 60, INK, 1)
    lines = [
        '设 f(x) 在 [a,b] 上连续, 在 (a,b) 内可导,',
        '则存在 ξ∈[a,b], 使',
        '    f(b) − f(a) = f′(ξ)(b − a)',
        '几何意义: 曲线上有一点的切线 ∥ 弦 AB',
        '证: 作辅助函数 φ(x) = f(x) − 弦 AB',
        '    φ(a) = φ(b), 由罗尔定理得证.',
    ]
    xs = []
    for i, s in enumerate(lines):
        xs.append(write(ink, 160, 214 + i * 128, s, 54, INK, 20 + i, slant=-1.5))
    # 第 2 行把开区间写成了闭区间：圈出来、打叉、旁注
    ellipse(rd, 470, 356, 118, 46, RED, 5)
    cross(rd, xs[1] + 70, 350, 30, RED, 6)
    write(red, 640, 420, '应为开区间 (a,b)!', 46, RED, 7, slant=-4)
    pen_path(rd, [(262, 1008), (420, 1003), (600, 1012), (790, 1006)], RED, 5, 8)
    write(red, 1060, 70, '−3', 72, RED, 9, slant=-8)
    check(rd, xs[3] + 60, 640, 22, RED, 10)
    return base, ink, red


def sheet_aux():
    w, h = 1300, 1160
    base = paper(w, h, 23, ruled=60, margin=False)
    ink = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    red = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    rd = ImageDraw.Draw(red)
    write(ink, 120, 92, '16. 用罗尔定理证明中值定理', 58, (40, 40, 48), 31)
    lines = [
        '构造 φ(x) = f(x) − f(a) − [f(b)−f(a)]/(b−a) · x',
        '则 φ(a) = φ(b) ?',
        '由罗尔定理, 存在 ξ 使 φ′(ξ) = 0',
        '∴ f′(ξ) = [f(b) − f(a)] / (b − a)',
    ]
    xs = []
    for i, s in enumerate(lines):
        xs.append(write(ink, 120, 230 + i * 150, s, 50, INK, 40 + i, slant=-2))
    # 辅助函数末项写成了 x：圈出、上方改成 (x − a)；第 2 行打叉
    ellipse(rd, xs[0] - 40, 258, 52, 44, RED, 41)
    write(red, xs[0] - 150, 150, '(x − a)', 48, RED, 42, slant=-5)
    cross(rd, xs[1] + 60, 400, 28, RED, 43)
    write(red, xs[1] + 120, 380, 'φ(a) ≠ φ(b)', 44, RED, 44, slant=-3)
    check(rd, xs[2] + 50, 548, 22, RED, 45)
    check(rd, xs[3] + 50, 698, 22, RED, 46)
    write(red, 140, 860, '辅助函数写错, 订正后再做一遍', 48, RED, 47, slant=-2)
    pen_path(rd, [(140, 930), (420, 926), (760, 934)], RED, 5, 48)
    return base, ink, red


def compose_sheet(base, ink, red):
    ink = ink.filter(ImageFilter.GaussianBlur(0.7))
    red = red.filter(ImageFilter.GaussianBlur(0.8))
    out = base.convert('RGBA')
    out.alpha_composite(ink)
    out.alpha_composite(red)
    return out


def desk(kind, seed):
    rnd = random.Random(seed)
    if kind == 'wood':
        im = Image.new('RGB', (S, S), (150, 108, 72))
        d = ImageDraw.Draw(im)
        for i in range(0, S, 3):
            shade = int(18 * math.sin(i * 0.021 + rnd.random() * 0.4) + 10 * math.sin(i * 0.11))
            d.line([(0, i), (S, i + rnd.randint(-6, 6))], fill=(150 + shade, 108 + shade, 72 + shade // 2), width=3)
        im = im.rotate(8, resample=Image.BICUBIC, expand=False, fillcolor=(150, 108, 72))
    else:
        im = Image.new('RGB', (S, S), (196, 199, 204))
    grain = noise_layer(S // 2, S // 2, 14, seed + 1, 1.0).resize((S, S))
    return ImageChops.add(im, Image.merge('RGB', [grain] * 3), scale=1.0, offset=-128)


def perspective(img, w, h, quad):
    """把 img 贴进目标四边形 quad（左上、右上、右下、左下），返回 w×h。"""
    src = [(0, 0), (img.width, 0), (img.width, img.height), (0, img.height)]
    # 解单应矩阵：目标 → 源（PIL 的 PERSPECTIVE 系数）
    A, B = [], []
    for (x, y), (u, v) in zip(quad, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        B += [u, v]
    coeffs = solve(A, B)
    return img.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC)


def solve(A, B):
    n = len(B)
    M = [row[:] + [b] for row, b in zip(A, B)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        for r in range(n):
            if r != c:
                k = M[r][c] / M[c][c]
                M[r] = [a - k * b for a, b in zip(M[r], M[c])]
    return [M[i][n] / M[i][i] for i in range(n)]


def light(img, cx, cy, warm):
    """柔和的环境光：一侧亮一侧暗 + 暗角，整体略偏暖 / 偏冷。"""
    g = Image.new('L', (S // 8, S // 8))
    gd = []
    for y in range(S // 8):
        for x in range(S // 8):
            dx, dy = x / (S / 8) - cx, y / (S / 8) - cy
            d = math.sqrt(dx * dx + dy * dy)
            gd.append(int(255 * max(0.0, min(1.0, 1.08 - 0.55 * d))))
    g.putdata(gd)
    g = g.resize((S, S), Image.BICUBIC).filter(ImageFilter.GaussianBlur(30))
    shaded = ImageChops.multiply(img, Image.merge('RGB', [g] * 3))
    tint = Image.new('RGB', (S, S), (255, 246, 232) if warm else (238, 244, 255))
    return ImageChops.multiply(shaded, tint)


def shoot(sheet, kind, quad, shadow_off, light_at, warm, seed, name):
    bg = desk(kind, seed).convert('RGBA')
    mask = Image.new('L', sheet.size, 255)
    paper_img = perspective(sheet, S, S, quad)
    paper_mask = perspective(mask, S, S, quad)
    shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sm = paper_mask.filter(ImageFilter.GaussianBlur(26)).point(lambda v: int(v * 0.55))
    shadow.putalpha(sm)
    shadow = ImageChops.offset(shadow, *shadow_off)
    bg.alpha_composite(Image.composite(Image.new('RGBA', (S, S), (20, 18, 16, 255)), Image.new('RGBA', (S, S), (0, 0, 0, 0)), shadow.split()[3]))
    paper_img.putalpha(paper_mask)
    bg.alpha_composite(paper_img)
    img = light(bg.convert('RGB'), *light_at, warm)
    sensor = noise_layer(S, S, 9, seed + 7)
    img = ImageChops.add(img, Image.merge('RGB', [sensor] * 3), scale=1.0, offset=-128)
    img = img.filter(ImageFilter.GaussianBlur(0.9)).resize((SIZE, SIZE), Image.LANCZOS)
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    img.save(path, 'WEBP', quality=88, method=6)
    print(path, img.size)


if __name__ == '__main__':
    shoot(
        compose_sheet(*sheet_mvt()),
        'wood',
        [(170, 110), (1480, 190), (1430, 1500), (110, 1420)],
        (34, 40),
        (0.25, 0.2),
        True,
        101,
        'mvt.webp',
    )
    shoot(
        compose_sheet(*sheet_aux()),
        'grey',
        [(100, 190), (1470, 90), (1530, 1460), (150, 1540)],
        (-30, 44),
        (0.8, 0.15),
        False,
        202,
        'aux-fn.webp',
    )

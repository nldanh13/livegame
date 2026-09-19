#!/usr/bin/env python3
"""Tạo chất liệu lát liền mạch (cỏ, đá lát, đất) cho overlay. Chạy: python3 tools/make_textures.py
Cần: pip install numpy pillow. Kết quả ghi vào public/assets/tex/. Bạn có thể thay bằng ảnh chất liệu thật
(Poly Haven, ambientCG...) cùng tên file để đẹp hơn nữa."""
import os, numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'assets', 'tex')
os.makedirs(OUT, exist_ok=True)

def pnoise(n, beta, seed):
    """Nhiễu tuần hoàn (lát liền mạch) theo phổ 1/f^beta, chuẩn hóa về 0..1."""
    rng = np.random.default_rng(seed)
    f = np.fft.fftfreq(n)[:, None] ** 2 + np.fft.fftfreq(n)[None, :] ** 2
    f[0, 0] = 1
    spec = (rng.normal(size=(n, n)) + 1j * rng.normal(size=(n, n))) / (f ** (beta / 2))
    spec[0, 0] = 0
    a = np.real(np.fft.ifft2(spec))
    a -= a.min(); a /= a.max() or 1
    return a

def ramp(t, stops):
    t = np.clip(t, 0, 1); out = np.zeros(t.shape + (3,), float)
    xs = [s[0] for s in stops]
    for c in range(3): out[..., c] = np.interp(t, xs, [s[1][c] for s in stops])
    return out

def tiled_draw(n, fn):
    """Vẽ bằng PIL trên ảnh 3x3 rồi cắt giữa để nét vẽ tràn mép vẫn liền mạch."""
    big = Image.new('RGBA', (n * 3, n * 3), (0, 0, 0, 0)); d = ImageDraw.Draw(big, 'RGBA'); fn(d, n)
    return big.crop((n, n, 2 * n, 2 * n))

def save(arr, name):
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(os.path.join(OUT, name), optimize=True)

def grass(n=512):
    rng = np.random.default_rng(7)
    low = pnoise(n, 3.2, 1); mid = pnoise(n, 2.0, 2); fine = pnoise(n, 0.8, 3)
    t = 0.55 * low + 0.3 * mid + 0.15 * fine
    base = ramp((t - t.min()) / (t.max() - t.min()), [(0, (44, 112, 30)), (.45, (78, 150, 44)), (.8, (112, 184, 58)), (1, (150, 210, 84))])
    img = Image.fromarray(base.astype(np.uint8)).convert('RGBA')
    def blades(d, n):
        for _ in range(5200):
            x, y = rng.uniform(0, 3 * n), rng.uniform(0, 3 * n); l = rng.uniform(5, 13); a = rng.normal(-1.57, .38)
            dx, dy = np.cos(a) * l, np.sin(a) * l; k = rng.random()
            col = (30, 95, 25, 150) if k < .4 else (170, 225, 96, 150) if k < .75 else (96, 168, 48, 140)
            d.line([(x, y), (x + dx * .5 + rng.normal(0, 1.2), y + dy * .5), (x + dx, y + dy)], fill=col, width=1)
    img.alpha_composite(tiled_draw(n, blades))
    a = np.array(img.convert('RGB')).astype(float)
    a *= (0.93 + 0.14 * pnoise(n, 1.4, 9))[..., None]
    save(a, 'grass.png')

def cobble(n=512, pts=30):
    rng = np.random.default_rng(3)
    P = rng.uniform(0, n, size=(pts, 2))
    # lưới điểm lệch nhẹ để đá đều tay hơn
    g = int(np.sqrt(pts)) + 1; P = np.array([[(i + rng.uniform(.15, .85)) * n / g, (j + rng.uniform(.15, .85)) * n / g] for i in range(g) for j in range(g)])
    ys, xs = np.mgrid[0:n, 0:n].astype(float)
    dists = []
    for (px, py) in P:
        dx = np.abs(xs - px); dx = np.minimum(dx, n - dx); dy = np.abs(ys - py); dy = np.minimum(dy, n - dy)
        dists.append(np.hypot(dx * 1.0, dy * 1.12))
    D = np.stack(dists, 0); idx = D.argmin(0); srt = np.sort(D, 0); d1, d2 = srt[0], srt[1]
    edge = d2 - d1
    h = np.clip(edge / 9.0, 0, 1); h = h * h * (3 - 2 * h)          # độ cao viên đá: cao ở giữa, thấp ở khe vữa
    gy, gx = np.gradient(h)
    shade = np.clip(0.78 + (-gx * 1.0 - gy * 1.0) * 3.2, .45, 1.12)  # ánh sáng từ trên-trái
    tone = rng.uniform(.82, 1.12, size=len(P))[idx]
    warm = rng.uniform(-10, 12, size=len(P))[idx]
    fine = pnoise(n, 1.6, 5)
    base = np.stack([222 + warm, 208 + warm * .6, 176 - warm * .4], -1) * (tone * (0.9 + .2 * fine))[..., None]
    col = base * shade[..., None] * (0.55 + 0.45 * h[..., None])
    mortar = np.array([92, 80, 62], float) * (0.85 + .3 * fine[..., None])
    m = np.clip(1 - h * 1.15, 0, 1)[..., None]
    col = col * (1 - m) + mortar * m
    save(col, 'cobble.png')

def dirt(n=512):
    t = 0.6 * pnoise(n, 2.4, 11) + 0.4 * pnoise(n, 1.2, 12)
    base = ramp((t - t.min()) / (t.max() - t.min()), [(0, (150, 112, 68)), (.5, (188, 150, 96)), (1, (214, 182, 124))])
    img = Image.fromarray(base.astype(np.uint8)).convert('RGBA'); rng = np.random.default_rng(21)
    def stones(d, n):
        for _ in range(900):
            x, y = rng.uniform(0, 3 * n), rng.uniform(0, 3 * n); r = rng.uniform(1, 3.4); v = rng.uniform(.6, 1.15)
            c = (int(150 * v), int(132 * v), int(104 * v), 220)
            d.ellipse([x - r, y - r * .8, x + r, y + r * .8], fill=c, outline=(70, 56, 40, 160))
        for _ in range(2200):
            x, y = rng.uniform(0, 3 * n), rng.uniform(0, 3 * n); d.point((x, y), fill=(90, 66, 40, 120))
    img.alpha_composite(tiled_draw(n, stones))
    save(np.array(img.convert('RGB')).astype(float), 'dirt.png')

if __name__ == '__main__':
    grass(); cobble(); dirt(); print('Đã tạo grass.png, cobble.png, dirt.png trong', os.path.normpath(OUT))

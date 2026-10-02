"""Значки «Захвата» (задача 1): синий квадрат с белым микрофоном → icons/icon-192.png, icon-512.png, icon.svg.

Только стандартная библиотека (zlib + struct). Запуск из папки проекта:
    python tools\\make_icons.py
Микрофон помещается в центральные 60% — так значок не обрежется круглой маской Android.
"""
import math
import struct
import zlib
from pathlib import Path

BG = (31, 95, 168)      # синий фон
FG = (255, 255, 255)    # белый микрофон
OUT = Path(__file__).resolve().parent.parent / "icons"

# Геометрия в долях стороны (0..1)
CX = 0.5
CAP_TOP, CAP_BOTTOM, CAP_R = 0.30, 0.47, 0.085     # «капсула» микрофона
ARC_R, ARC_W = 0.165, 0.035                        # дуга-держатель
STEM = (CX - 0.0175, 0.635, CX + 0.0175, 0.72)     # ножка
BASE = (0.40, 0.70, 0.60, 0.735)                   # подставка


def inside(x: float, y: float) -> bool:
    """Точка (x, y) попадает в белую часть рисунка?"""
    # капсула: всё, что ближе CAP_R к вертикальному отрезку
    cy = min(max(y, CAP_TOP), CAP_BOTTOM)
    if math.hypot(x - CX, y - cy) <= CAP_R:
        return True
    # дуга: нижняя половина кольца вокруг низа капсулы
    if y >= CAP_BOTTOM and abs(math.hypot(x - CX, y - CAP_BOTTOM) - ARC_R) <= ARC_W / 2:
        return True
    for x0, y0, x1, y1 in (STEM, BASE):
        if x0 <= x <= x1 and y0 <= y <= y1:
            return True
    return False


def render(size: int) -> bytes:
    """Картинка size×size, сглаживание — 4×4 точки на пиксель."""
    rows = []
    n = 4
    for py in range(size):
        row = bytearray([0])   # фильтр строки PNG: «нет»
        for px in range(size):
            hits = sum(
                inside((px + (i + 0.5) / n) / size, (py + (j + 0.5) / n) / size)
                for i in range(n) for j in range(n)
            )
            k = hits / (n * n)
            row += bytes(round(b + (f - b) * k) for b, f in zip(BG, FG))
        rows.append(bytes(row))
    return b"".join(rows)


def png(size: int) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)   # 8 бит, RGB
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(render(size), 9)) + chunk(b"IEND", b""))


def svg() -> str:
    s = 100
    x0, y0, x1, y1 = (v * s for v in STEM)
    b0, c0, b1, c1 = (v * s for v in BASE)
    r = ARC_R * s
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}">'
        f'<rect width="{s}" height="{s}" rx="18" fill="rgb{BG}"/>'
        f'<rect x="{(CX - CAP_R) * s:g}" y="{(CAP_TOP - CAP_R) * s:g}" width="{2 * CAP_R * s:g}" '
        f'height="{(CAP_BOTTOM - CAP_TOP + 2 * CAP_R) * s:g}" rx="{CAP_R * s:g}" fill="#fff"/>'
        f'<path d="M{(CX - ARC_R) * s:g} {CAP_BOTTOM * s:g}a{r:g} {r:g} 0 0 0 {2 * r:g} 0" '
        f'fill="none" stroke="#fff" stroke-width="{ARC_W * s:g}"/>'
        f'<rect x="{x0:g}" y="{y0:g}" width="{x1 - x0:g}" height="{y1 - y0:g}" fill="#fff"/>'
        f'<rect x="{b0:g}" y="{c0:g}" width="{b1 - b0:g}" height="{c1 - c0:g}" fill="#fff"/>'
        f'</svg>\n'
    )


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for size in (192, 512):
        (OUT / f"icon-{size}.png").write_bytes(png(size))
    (OUT / "icon.svg").write_text(svg(), encoding="utf-8")
    print("Готово:", ", ".join(p.name for p in sorted(OUT.iterdir())))

"""Временный значок «Разбора» на телефоне (Органайзер КАА, задача 248.12): зелёный квадрат, белые строки списка и галочка.
Замените на значок из программы «Значки», когда он будет готов (те же файлы icons/icon-192.png, icon-512.png, icon.svg).

Только стандартная библиотека. Запуск из папки razbor:  python make_icons.py
Рисунок — в центральных 60%, чтобы круглая маска Android его не обрезала.
"""
import struct
import zlib
from pathlib import Path

BG, FG = (46, 125, 91), (255, 255, 255)
OUT = Path(__file__).resolve().parent / "icons"
BARS = [(0.42, 0.30, 0.74, 0.36), (0.42, 0.47, 0.74, 0.53), (0.42, 0.64, 0.74, 0.70)]   # строки списка (x0, y0, x1, y1)


def _near_segment(x, y, ax, ay, bx, by, w):
    """Точка ближе w к отрезку?"""
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= w * w


def inside(x, y):
    if any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in BARS):
        return True
    # галочка слева от первой и второй строк
    return _near_segment(x, y, 0.22, 0.42, 0.28, 0.49, 0.03) or _near_segment(x, y, 0.28, 0.49, 0.37, 0.31, 0.03)


def render(size):
    rows = []
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            hits = sum(inside((i + (a + 0.5) / 4) / size, (j + (b + 0.5) / 4) / size) for a in range(4) for b in range(4)) / 16
            row += bytes(round(BG[k] + (FG[k] - BG[k]) * hits) for k in range(3))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for s in (192, 512):
        (OUT / f"icon-{s}.png").write_bytes(render(s))
    bars = "".join(f'<rect x="{x0*100:g}" y="{y0*100:g}" width="{(x1-x0)*100:g}" height="{(y1-y0)*100:g}" rx="3" fill="#fff"/>' for x0, y0, x1, y1 in BARS)
    (OUT / "icon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="18" fill="rgb(46, 125, 91)"/>'
        f'{bars}<path d="M22 42l6 7 9-18" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        encoding="utf-8")
    print("готово:", OUT)

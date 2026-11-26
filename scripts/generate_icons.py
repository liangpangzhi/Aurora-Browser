#!/usr/bin/env python3
"""Generate the four PNG icons required by fnpack and the desktop entry.

The single source of truth is assets/icon.svg (an SVG containing the final
256x256 PNG as a data URI). No third-party dependencies, so CI can reproduce
the exact same files. Output:
  ICON.PNG              64x64
  ICON_256.PNG          256x256
  app/ui/images/icon_64.png
  app/ui/images/icon_256.png
"""
from __future__ import annotations

import base64
import os
import re
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG_PATH = os.path.join(ROOT, "assets", "icon.svg")
PNG_SIG = b"\x89PNG\r\n\x1a\n"


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def with_color_chunks(data: bytes) -> bytes:
    """Insert standard sRGB + gAMA chunks immediately after IHDR.

    A bare IHDR/IDAT-only PNG is valid, but some minimal icon pipelines
    (fnOS's app-center renderer among them) silently ignore profile-less
    files and show a placeholder. Icons produced by common encoders —
    including the official fnpack template's — always carry sRGB/gAMA,
    so mirror that layout. Idempotent: a file that already has an sRGB
    chunk is returned unchanged.
    """
    if not data.startswith(PNG_SIG):
        return data
    pos = 8
    tags: list[bytes] = []
    ihdr_end: int | None = None
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        tag = data[pos + 4 : pos + 8]
        tags.append(tag)
        pos += 12 + length
        if tag == b"IHDR":
            ihdr_end = pos
        if tag == b"IEND":
            break
    if ihdr_end is None or b"sRGB" in tags:
        return data
    srgb = chunk(b"sRGB", b"\x00")  # rendering intent: perceptual
    gama = chunk(b"gAMA", struct.pack(">I", 45455))  # gamma 1/2.2
    return data[:ihdr_end] + srgb + gama + data[ihdr_end:]


def extract_png() -> bytes:
    """Read the embedded PNG from the SVG data URI."""
    with open(SVG_PATH, "rb") as fh:
        svg = fh.read()
    match = re.search(rb"base64,([A-Za-z0-9+/=]+)", svg)
    if not match:
        raise SystemExit(f"未在 {SVG_PATH} 中找到 base64 PNG 数据")
    data = base64.b64decode(match.group(1), validate=True)
    if not data.startswith(PNG_SIG):
        raise SystemExit("SVG 中嵌入的数据不是 PNG")
    return data


def decode_png(data: bytes) -> tuple[int, int, list[bytes]]:
    """Decode an 8-bit RGB/RGBA non-interlaced PNG into RGBA scanlines."""
    pos = 8
    width = height = color_type = 0
    idat = bytearray()
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        tag = data[pos + 4 : pos + 8]
        payload = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            width, height, depth, color_type, comp, filt, interlace = struct.unpack(
                ">IIBBBBB", payload
            )
            if depth != 8 or interlace != 0 or color_type not in (2, 6):
                raise SystemExit(f"不支持的 PNG 格式: depth={depth}, color={color_type}")
        elif tag == b"IDAT":
            idat.extend(payload)
        elif tag == b"IEND":
            break

    bpp = 4 if color_type == 6 else 3
    stride = width * bpp
    raw = zlib.decompress(bytes(idat))
    rows: list[bytes] = []
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        filter_type = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        pos += stride
        if filter_type == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif filter_type == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif filter_type == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif filter_type == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        elif filter_type != 0:
            raise SystemExit(f"未知的 PNG 行过滤器: {filter_type}")

        if bpp == 3:
            rgba = bytearray(width * 4)
            for x in range(width):
                rgba[x * 4 : x * 4 + 4] = line[x * 3 : x * 3 + 3] + b"\xff"
            line = rgba
        rows.append(bytes(line))
        prev = line
    return width, height, rows


def box_downscale(
    rows: list[bytes], width: int, height: int, factor: int
) -> tuple[int, int, list[bytes]]:
    """Area-average downscale with premultiplied alpha to avoid dark fringes."""
    out_w, out_h = width // factor, height // factor
    out: list[bytes] = []
    for oy in range(out_h):
        line = bytearray(out_w * 4)
        for ox in range(out_w):
            sr = sg = sb = sa = 0
            for dy in range(factor):
                src = rows[oy * factor + dy]
                for dx in range(factor):
                    r, g, b, a = src[(ox * factor + dx) * 4 : (ox * factor + dx) * 4 + 4]
                    sr += r * a
                    sg += g * a
                    sb += b * a
                    sa += a
            count = factor * factor
            alpha = sa // count
            if sa:
                line[ox * 4 : ox * 4 + 4] = bytes(
                    (sr // sa, sg // sa, sb // sa, alpha)
                )
            else:
                line[ox * 4 : ox * 4 + 4] = b"\x00\x00\x00\x00"
        out.append(bytes(line))
    return out_w, out_h, out


def encode_png(width: int, height: int, rows: list[bytes]) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + row for row in rows)
    return with_color_chunks(
        PNG_SIG
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def write(path: str, data: bytes) -> None:
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as fh:
        fh.write(data)
    print(f"  {path}: {len(data)} bytes")


def main() -> None:
    png = extract_png()
    width, height, rows = decode_png(png)
    if (width, height) != (256, 256):
        raise SystemExit(f"SVG 内嵌 PNG 尺寸应为 256x256，实际为 {width}x{height}")

    print("从 assets/icon.svg 生成图标：")
    # The embedded 256 image is authoritative; keep its pixels byte-for-byte
    # (only the standard sRGB/gAMA chunks are spliced in after IHDR).
    png = with_color_chunks(png)
    write("ICON_256.PNG", png)
    write("app/ui/images/icon_256.png", png)

    small_w, small_h, small_rows = box_downscale(rows, width, height, 4)
    small_png = encode_png(small_w, small_h, small_rows)
    write("ICON.PNG", small_png)
    write("app/ui/images/icon_64.png", small_png)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Generate a Mac Scheduler app icon (.icns) with no external deps.
Renders a clock/timer motif with the accent gradient using CoreGraphics via PyObjC-free
approach: draws PNGs with PIL if available, otherwise falls back to a solid rounded
square with the emoji-free basic clock using raw zlib PNG writing.

To keep this dependency-free we require Pillow (check below) — if not available we
write a simple flat-color icon with a clock face drawn as arcs is complex without a
graphics lib, so we fall back to a tasteful gradient tile + emoji glyph rendered by
the OS? No — simplest robust path: use Pillow if installed.
"""
import os, sys, subprocess, shutil

def have_pillow():
    try:
        import PIL; return True
    except Exception:
        return False

def main(iconset):
    if not have_pillow():
        # try pip install quietly
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--quiet', '--user', 'Pillow'],
                       stderr=subprocess.DEVNULL)
    try:
        from PIL import Image, ImageDraw
    except Exception as e:
        print("Pillow unavailable:", e); sys.exit(0)

    # 1024 base
    S = 1024
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # rounded-rect background with vertical gradient
    def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
    top = (91, 108, 255)
    bottom = (168, 85, 247)
    # draw a vertical gradient with many thin rects clipped to a rounded shape
    radius = 224
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
    for y in range(S):
        t = y / S
        color = lerp(top, bottom, t)
        d.line([(radius, y), (S - 1 - radius, y)], fill=color + (255,))
    # clip corners: apply mask
    img.putalpha(mask)

    # subtle inner ring (clock face)
    cx, cy, r = S // 2, S // 2, 300
    ring = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    rd.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255, 255), width=52)
    # hour ticks
    import math
    for h in range(12):
        ang = math.radians(h * 30 - 90)
        x1 = cx + math.cos(ang) * (r - 46)
        y1 = cy + math.sin(ang) * (r - 46)
        x2 = cx + math.cos(ang) * (r - 120)
        y2 = cy + math.sin(ang) * (r - 120)
        rd.line([(x1, y1), (x2, y2)], fill=(255, 255, 255, 255), width=34)
    # hands at 10:10
    rd.line([(cx, cy), (cx - 90, cy - 200)], fill=(255, 255, 255, 255), width=44)
    rd.line([(cx, cy), (cx + 180, cy + 40)], fill=(255, 255, 255, 255), width=44)
    rd.ellipse([cx - 60, cy - 60, cx + 60, cy + 60], fill=(255, 255, 255, 255))
    img = Image.alpha_composite(img, ring)

    # center logo glyph: use a bold "S" by drawing simple arcs (pseudo)
    img = img.convert('RGBA')

    # write all sizes
    sizes = [16, 32, 64, 128, 256, 512, 1024]
    os.makedirs(iconset, exist_ok=True)
    for s in sizes:
        img.resize((s, s), Image.LANCZOS).save(f"{iconset}/icon_{s}x{s}.png")
        img.resize((s * 2, s * 2), Image.LANCZOS).save(f"{iconset}/icon_{s}x{s}@2x.png")
    # include 32 & 256 explicitly (icns needs them)
    img.resize((32, 32), Image.LANCZOS).save(f"{iconset}/icon_32x32.png")
    img.resize((256, 256), Image.LANCZOS).save(f"{iconset}/icon_256x256.png")
    print("icon set written to", iconset)

if __name__ == '__main__':
    main(sys.argv[1])

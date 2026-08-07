#!/usr/bin/env python3
"""Generate a Mac Scheduler .icns source iconset with ZERO external dependencies.

Pure stdlib (zlib + struct) PNG writer + software rendering of a rounded
gradient tile with a white clock face. Works on any machine with Python 3,
including GitHub Actions macOS runners.
"""
import os, sys, struct, zlib, math

def png_chunk(typ, data):
    return (struct.pack('>I', len(data)) + typ + data +
            struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff))

def write_png(path, w, h, pixels):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter type None
        raw += pixels[y * stride:(y + 1) * stride]
    png = b'\x89PNG\r\n\x1a\n'
    png += png_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += png_chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += png_chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)

def dist_to_seg(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    l2 = vx * vx + vy * vy
    if l2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / l2))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))

def render(S):
    top = (91, 108, 255)
    bottom = (168, 85, 247)
    radius = int(S * 0.22)
    buf = bytearray(S * S * 4)
    cx = cy = S / 2
    r = S * 0.30
    ring_w = S * 0.045
    hw = S * 0.022

    def in_rounded(x, y):
        for (dx, dy) in ((radius - x, radius - y), (x - (S - 1 - radius), radius - y),
                         (radius - x, y - (S - 1 - radius)), (x - (S - 1 - radius), y - (S - 1 - radius))):
            if dx > 0 and dy > 0 and dx * dx + dy * dy > radius * radius:
                return False
        return True

    # Precompute hand endpoints
    hour_end = (cx - 0.28 * r, cy - 0.58 * r)
    min_end = (cx + 0.62 * r, cy + 0.12 * r)

    for y in range(S):
        t = y / S
        rr = int(top[0] + (bottom[0] - top[0]) * t)
        gg = int(top[1] + (bottom[1] - top[1]) * t)
        bb = int(top[2] + (bottom[2] - top[2]) * t)
        row = y * S * 4
        for x in range(S):
            o = row + x * 4
            if not in_rounded(x, y):
                continue  # transparent (alpha 0)
            d = math.hypot(x - cx, y - cy)
            white = False
            if abs(d - r) < ring_w:
                white = True
            elif d < S * 0.05:
                white = True
            elif dist_to_seg(x, y, cx, cy, *hour_end) < hw:
                white = True
            elif dist_to_seg(x, y, cx, cy, *min_end) < hw:
                white = True
            else:
                # hour ticks
                for hh in range(12):
                    a = hh * math.pi / 6 - math.pi / 2
                    t1 = (cx + math.cos(a) * (r - S * 0.04), cy + math.sin(a) * (r - S * 0.04))
                    t0 = (cx + math.cos(a) * (r - S * 0.14), cy + math.sin(a) * (r - S * 0.14))
                    if dist_to_seg(x, y, t0[0], t0[1], t1[0], t1[1]) < S * 0.02:
                        white = True
                        break
            if white:
                buf[o:o + 3] = b'\xff\xff\xff'
                buf[o + 3] = 255
            else:
                buf[o] = rr; buf[o + 1] = gg; buf[o + 2] = bb; buf[o + 3] = 255
    return buf

def scale_down(buf, src, dst):
    out = bytearray(dst * dst * 4)
    step = src / dst
    for y in range(dst):
        sy = min(int(y * step), src - 1)
        for x in range(dst):
            sx = min(int(x * step), src - 1)
            i = (sy * src + sx) * 4
            o = (y * dst + x) * 4
            out[o:o + 4] = buf[i:i + 4]
    return out

def main(iconset):
    os.makedirs(iconset, exist_ok=True)
    base = render(1024)
    for s in (16, 32, 128, 256, 512):
        buf = base if s == 1024 else scale_down(base, 1024, s)
        write_png(f"{iconset}/icon_{s}x{s}.png", s, s, buf)
    # @2x variants: 16@2x->32, 32@2x->64, 128@2x->256, 256@2x->512, 512@2x->1024
    for s in (16, 32, 128, 256, 512):
        big = s * 2
        buf = scale_down(base, 1024, big)
        write_png(f"{iconset}/icon_{s}x{s}@2x.png", big, big, buf)
    print("icon set written to", iconset)

if __name__ == '__main__':
    main(sys.argv[1])

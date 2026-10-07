#!/usr/bin/env python3
"""从参考 UI 截图里采样主色（纯标准库实现 PNG 解码，只为取色，不引依赖）。"""
import sys, zlib, struct


def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    pos = 8
    idat = b''
    w = h = bitd = ct = None
    plte = None
    while pos < len(data):
        ln, typ = struct.unpack('>I4s', data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, bitd, ct, _, _, inter = struct.unpack('>IIBBBBB', chunk)
            assert inter == 0, 'interlaced not supported'
        elif typ == b'PLTE':
            plte = chunk
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    nch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    assert bitd == 8, bitd
    stride = w * nch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                b = prev[i]
                c = prev[i - nch] if i >= nch else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, nch, bytes(out), ct, plte


def px(w, nch, buf, x, y, ct, plte):
    i = (y * w + x) * nch
    if ct == 3:
        idx = buf[i]
        return (plte[idx * 3], plte[idx * 3 + 1], plte[idx * 3 + 2])
    if ct in (2, 6):
        return (buf[i], buf[i + 1], buf[i + 2])
    v = buf[i]
    return (v, v, v)


def hexs(c):
    return '#%02X%02X%02X' % c


def main():
    for path in sys.argv[1:]:
        w, h, nch, buf, ct, plte = read_png(path)
        print('==', path, w, 'x', h, 'ct=%d' % ct)
        pts = {
            'page_bg': (20, int(h * 0.62)),
            'header_title': (int(w * 0.10), int(h * 0.095)),
            'hero_card': (int(w * 0.10), int(h * 0.175)),
            'hero_badge': (int(w * 0.50), int(h * 0.176)),
            'card1': (int(w * 0.13), int(h * 0.34)),
            'card2': (int(w * 0.66), int(h * 0.34)),
            'card3': (int(w * 0.13), int(h * 0.50)),
            'card4': (int(w * 0.66), int(h * 0.50)),
            'card5': (int(w * 0.13), int(h * 0.66)),
            'tailbar': (int(w * 0.30), int(h * 0.775)),
            'tabbar': (int(w * 0.50), int(h * 0.955)),
        }
        for k, (x, y) in pts.items():
            x = max(0, min(w - 1, x)); y = max(0, min(h - 1, y))
            print('  %-12s (%4d,%4d) %s' % (k, x, y, hexs(px(w, nch, buf, x, y, ct, plte))))


main()
'use strict';

/**
 * 资源生成器 —— 用纯标准库（zlib + struct）手写 PNG，不引任何第三方依赖。
 *
 *   node scripts/assets/gen-assets.js
 *
 * 为什么不用 canvas / sharp：
 *   这些图标只有十几个像素色块，为它们装一整条 node 原生依赖链不值当，
 *   而且 CI 上免安装就能重跑，图标可复现、可 diff。
 *
 * 产出（写进 miniprogram/images/）：
 *   tabbar/today|week|mine.png        未选中：#0E0E10 线稿
 *   tabbar/today|week|mine-on.png     选中：#FFFFFF 线稿（落在黑色圆角块上）
 *   mascot.png                「好饭」头像：浅灰圆底 + 柠檬黄脸 + 弯眼笑嘴
 *
 * 色值全部来自 docs/UI参考 的取样结果，改配色先改这里的 PALETTE。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- 调色板（与 miniprogram/app.wxss 的 token 一一对应） ---------------- */

const PALETTE = {
  ink: [0x0e, 0x0e, 0x10], // 主文 / 未选中图标
  white: [0xff, 0xff, 0xff],
  lime: [0xe9, 0xf9, 0x4e], // 品牌强调
  mist: [0xf2, 0xf2, 0xf4], // 头像圆底 / 浅灰块
};

/* ---------------- 极简 RGBA 画布（4x 超采样抗锯齿） ---------------- */

const SS = 4; // 超采样倍数

function createCanvas(w, h) {
  return { w, h, data: new Float64Array(w * SS * h * SS * 4) };
}

function blend(canvas, x, y, rgb, alpha) {
  if (x < 0 || y < 0 || x >= canvas.w * SS || y >= canvas.h * SS || alpha <= 0) return;
  const i = (y * canvas.w * SS + x) * 4;
  const d = canvas.data;
  const a = Math.min(1, alpha);
  d[i] = rgb[0] * a + d[i] * (1 - a);
  d[i + 1] = rgb[1] * a + d[i + 1] * (1 - a);
  d[i + 2] = rgb[2] * a + d[i + 2] * (1 - a);
  d[i + 3] = Math.min(1, d[i + 3] + a);
}

/**
 * 用「覆盖率」填充一个形状：形状内部返回 1，外部 0，边缘按像素覆盖比例插值。
 * fn 接收像素中心坐标（已换算成逻辑坐标），返回 true 表示命中。
 */
function fillShape(canvas, fn, rgb, alpha) {
  const W = canvas.w * SS;
  const H = canvas.h * SS;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = (x + 0.5) / SS;
      const cy = (y + 0.5) / SS;
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = cx - 0.5 + (sx + 0.5) / SS;
          const py = cy - 0.5 + (sy + 0.5) / SS;
          if (fn(px, py)) hit++;
        }
      }
      if (hit) blend(canvas, x, y, rgb, (hit / (SS * SS)) * alpha);
    }
  }
}

function fillRect(canvas, x0, y0, x1, y1, rgb, alpha) {
  fillShape(canvas, (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1, rgb, alpha);
}

function fillRoundRect(canvas, x0, y0, x1, y1, r, rgb, alpha) {
  fillShape(canvas, (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    if (x >= x0 + r && x <= x1 - r) return true;
    if (y >= y0 + r && y <= y1 - r) return true;
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
  }, rgb, alpha);
}

function fillCircle(canvas, cx, cy, r, rgb, alpha) {
  fillShape(canvas, (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r, rgb, alpha);
}

/** 圆环（描边圆） */
function strokeCircle(canvas, cx, cy, r, w, rgb, alpha) {
  const outer = r + w / 2;
  const inner = r - w / 2;
  fillShape(canvas, (x, y) => {
    const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    return d <= outer * outer && d >= inner * inner;
  }, rgb, alpha);
}

/** 圆弧线段：从 a0 到 a1（弧度，顺时针，0 = 正右），用于画「蒸气」「笑嘴」 */
function strokeArc(canvas, cx, cy, r, a0, a1, w, rgb, alpha) {
  const outer = r + w / 2;
  const inner = Math.max(0, r - w / 2);
  const norm = (a) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const s = norm(a0);
  const span = norm(a1) - s;
  fillShape(canvas, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const d = dx * dx + dy * dy;
    if (d > outer * outer || d < inner * inner) return false;
    let a = Math.atan2(dy, dx) - s;
    a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return a <= span;
  }, rgb, alpha);
}

/** 直线段（带圆头） */
function strokeLine(canvas, x0, y0, x1, y1, w, rgb, alpha) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  fillShape(canvas, (x, y) => {
    let t = ((x - x0) * dx + (y - y0) * dy) / len2;
    t = Math.min(1, Math.max(0, t));
    const px = x0 + t * dx;
    const py = y0 + t * dy;
    return (x - px) * (x - px) + (y - py) * (y - py) <= (w / 2) * (w / 2);
  }, rgb, alpha);
}

/** 椭圆（实心） */
function fillEllipse(canvas, cx, cy, rx, ry, rgb, alpha) {
  fillShape(canvas, (x, y) => {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }, rgb, alpha);
}

/* ---------------- PNG 编码 ---------------- */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 把画布降采样回目标分辨率并编码成 PNG Buffer */
function encodePNG(canvas) {
  const { w, h, data } = canvas;
  const px = Buffer.alloc(h * (w * 4 + 1));
  let o = 0;
  for (let y = 0; y < h; y++) {
    px[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * w * SS + (x * SS + sx)) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
        }
      }
      const n = SS * SS;
      px[o++] = Math.round(r / n);
      px[o++] = Math.round(g / n);
      px[o++] = Math.round(b / n);
      px[o++] = Math.round((a / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(px, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 图标：线稿风格 ---------------- */

const ICON = 81; // tabbar 图标标准边长（px）
const STROKE = 7;

/** 今日：一碗热汤（碗身 + 碗沿 + 两道蒸气） */
function drawToday(c, color) {
  const cx = ICON / 2;
  // 碗身：下半圆
  strokeArc(c, cx, 46, 20, 0, Math.PI, STROKE, color, 1);
  // 碗沿横线
  strokeLine(c, cx - 21, 46, cx + 21, 46, STROKE, color, 1);
  // 蒸气：两道弧
  strokeArc(c, cx - 11, 30, 7, Math.PI * 0.9, Math.PI * 2.1, 5.5, color, 1);
  strokeArc(c, cx + 11, 30, 7, Math.PI * 0.9, Math.PI * 2.1, 5.5, color, 1);
}

/** 一周：日历（圆角框 + 顶栏 + 两个挂耳 + 三颗点） */
function drawWeek(c, color) {
  const x0 = 15;
  const x1 = ICON - 15;
  const y0 = 20;
  const y1 = ICON - 17;
  const r = 9;
  // 外框（描边：用外圆角矩形减去内圆角矩形）
  fillShape(c, (x, y) => {
    const inOuter = roundRectHit(x, y, x0, y0, x1, y1, r);
    const inInner = roundRectHit(x, y, x0 + STROKE / 2, y0 + STROKE / 2, x1 - STROKE / 2, y1 - STROKE / 2, r - STROKE / 2);
    return inOuter && !inInner;
  }, color, 1);
  // 顶栏分隔线
  strokeLine(c, x0 + STROKE / 2, 34, x1 - STROKE / 2, 34, STROKE * 0.8, color, 1);
  // 挂耳
  strokeLine(c, 28, 12, 28, 26, STROKE, color, 1);
  strokeLine(c, ICON - 28, 12, ICON - 28, 26, STROKE, color, 1);
  // 三颗日期点
  fillCircle(c, 30, 47, 4, color, 1);
  fillCircle(c, ICON / 2, 47, 4, color, 1);
  fillCircle(c, ICON - 30, 47, 4, color, 1);
}

/** 我的：人形（头 + 肩） */
function drawMine(c, color) {
  const cx = ICON / 2;
  strokeCircle(c, cx, 29, 13, STROKE, color, 1);
  strokeArc(c, cx, 78, 25, Math.PI * 1.12, Math.PI * 1.88, STROKE, color, 1);
}

function roundRectHit(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  if (x >= x0 + r && x <= x1 - r) return true;
  if (y >= y0 + r && y <= y1 - r) return true;
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
}

/* ---------------- 吉祥物头像 ---------------- */

/**
 * 「好饭」小黄脸：浅灰圆底 + 柠檬黄脸 + 两点眼睛 + 弯笑嘴。
 * 尺寸取 132px：hero 卡里显示约 96rpx，留 1.4x 余量给高分屏。
 */
function drawMascot() {
  const S = 132;
  const c = createCanvas(S, S);
  const cx = S / 2;
  const cy = S / 2;
  fillCircle(c, cx, cy, 64, PALETTE.mist, 1); // 圆底
  fillCircle(c, cx, cy + 3, 47, PALETTE.lime, 1); // 脸
  // 眼睛：两颗小圆点
  fillCircle(c, cx - 16, cy - 2, 6.5, PALETTE.ink, 1);
  fillCircle(c, cx + 16, cy - 2, 6.5, PALETTE.ink, 1);
  // 笑嘴：下半弧
  strokeArc(c, cx, cy + 14, 15, Math.PI * 0.18, Math.PI * 0.82, 6, PALETTE.ink, 1);
  return encodePNG(c);
}

/* ---------------- 主流程 ---------------- */

function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  process.stdout.write('  ' + path.relative(path.resolve(__dirname, '../..'), file) + '  ' + buf.length + 'B\n');
}

function main() {
  const ROOT = path.resolve(__dirname, '../..');
  const IMG = path.join(ROOT, 'miniprogram/images');
  const icons = { today: drawToday, week: drawWeek, mine: drawMine };

  Object.keys(icons).forEach((name) => {
    const off = createCanvas(ICON, ICON);
    icons[name](off, PALETTE.ink);
    write(path.join(IMG, 'tabbar', name + '.png'), encodePNG(off));

    const on = createCanvas(ICON, ICON);
    icons[name](on, PALETTE.white);
    write(path.join(IMG, 'tabbar', name + '-on.png'), encodePNG(on));
  });

  write(path.join(IMG, 'mascot.png'), drawMascot());
  process.stdout.write('图标与吉祥物生成完毕\n');
}

main();
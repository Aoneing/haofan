// utils/layout.js — 与屏幕尺寸有关的纯计算
//
// 之所以单独抽成不依赖 wx 的纯函数：菜品详情页「全屏大图」的高度要在真机上按屏幕比例算，
// 纯函数才能在 node 里直接跑回归，不用起模拟器。
const DESIGN_WIDTH_PX_TO_RPX = 750;

// 图区高度 = max(屏宽 × MIN_RATIO, 可视高 × VH)，再封顶到可视高的 VH_MAX。
//   · 下限 MIN_RATIO：保证不会在宽屏上变成一条矮胖的横幅
//   · 上限 VH_MAX：永远给下方「做法」留一截，用户知道还能往下滚，而不是以为页面就这么点内容
const HERO_MIN_RATIO = 0.75;
const HERO_VH = 0.78;
const HERO_VH_MAX = 0.86;
// 拿不到窗口尺寸时的兜底（≈屏宽 × 0.72，与常见机型算出来的值同一量级）
const HERO_FALLBACK_RPX = 540;

/**
 * 菜品详情页全屏大图的高度（rpx）。宽度恒为满屏 750rpx。
 * @param {number} winW 可视宽度 px（wx.getSystemInfoSync().windowWidth）
 * @param {number} winH 可视高度 px（wx.getSystemInfoSync().windowHeight）
 * @returns {number} rpx
 */
function calcHeroHeight(winW, winH) {
  const w = Number(winW);
  const h = Number(winH);
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) return HERO_FALLBACK_RPX;
  const px = Math.min(Math.max(w * HERO_MIN_RATIO, h * HERO_VH), h * HERO_VH_MAX);
  return Math.round((px * DESIGN_WIDTH_PX_TO_RPX) / w);
}

module.exports = {
  calcHeroHeight,
  DESIGN_WIDTH_PX_TO_RPX,
  HERO_FALLBACK_RPX,
};

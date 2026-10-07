// utils/const.js — 餐次配色与文案常量
//
// 配色分两套，别混：
//   · TILE_TONES —— 新版 UI 的菜品色卡四色轮转（首页 / 一周 / 单日 / 我的都在用）
//   · MEAL_STYLE —— 导入校对页的行内色块。那里要「和 Excel 行序一一对照」，
//     色块是定位线索而不是装饰，所以仍按餐次固定配色，且必须两两不同色。
//
// bgStrong 是同色系加深版，用于「主餐（午餐/晚餐）突出显示」。
// 为什么不用加边框/阴影代替：色块本身有底色，描边会被吃掉，
// 只有把饱和度提上去才看得出层次。
const MEAL_STYLE = {
  breakfast: { bg: '#F4F4F8', bgStrong: '#C9C9E8', fg: '#0E0E10', label: '早餐' },
  lunch: { bg: '#E9F94E', bgStrong: '#C6D93A', fg: '#0E0E10', label: '午餐' },
  snack: { bg: '#D8F5E9', bgStrong: '#A5DEC6', fg: '#0E0E10', label: '加餐' },
  dinner: { bg: '#A9B6F2', bgStrong: '#7C8CD8', fg: '#0E0E10', label: '晚餐' },
};

// 一天里的主餐：午餐 + 晚餐。早餐/加餐属于配角，视觉上要退一层。
const MAIN_MEALS = ['lunch', 'dinner'];

function isMainMeal(meal) {
  return MAIN_MEALS.indexOf(meal) >= 0;
}

/**
 * 菜品色卡的四色轮转（新版 UI）。
 *
 * 为什么按「下标轮转」而不是按餐次配色：定稿图里同一顿饭的五张卡是
 * 黄绿 / 浅紫 / 墨绿 / 深紫 / 中紫 依次排开的，颜色跟着位置走。
 * 若改成「早餐永远黄绿、午餐永远墨绿」，一天只有五张卡时会出现
 * 两张同色并排，反而不如轮转错开得开。
 *
 * fg 一律写死在这张表里：浅底配深字、深底配白字，对比度是配色表的责任，
 * 留给组件去判断就一定会出现某一张卡看不清字。
 */
const TILE_TONES = [
  { bg: '#E9F94E', fg: '#0E0E10' }, // 柠檬黄
  { bg: '#A9B6F2', fg: '#0E0E10' }, // 浅紫
  { bg: '#1F3A3D', fg: '#FFFFFF' }, // 深墨绿
  { bg: '#3B3AAE', fg: '#FFFFFF' }, // 品牌深紫
];

/** 取轮转配色；下标越界自动取模，调用方不必自己防越界 */
function tileTone(i) {
  const n = TILE_TONES.length;
  return TILE_TONES[((Number(i) || 0) % n + n) % n];
}

const WEEKDAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const WARNING_TONE = { error: 'error', warn: 'warn', info: 'info' };

module.exports = {
  MEAL_STYLE,
  MAIN_MEALS,
  isMainMeal,
  TILE_TONES,
  tileTone,
  WEEKDAY_TEXT,
  WARNING_TONE,
};

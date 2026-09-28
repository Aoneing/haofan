// utils/const.js — 餐次配色与文案常量（与设计文档 6.3 节一致）
// bg：常规底色；bgStrong：同色系加深版，用于「主餐（午餐/晚餐）突出显示」时替换 bg。
// 为什么要单独一份加深色而不是加边框/阴影了事：餐次块本身就是色块，描边会被底色吃掉，
// 只有把底色饱和度提上去才看得出层次。
const MEAL_STYLE = {
  breakfast: { bg: '#FAEEDA', bgStrong: '#F6E2BC', fg: '#854F0B', label: '早餐' },
  lunch: { bg: '#EAF3DE', bgStrong: '#D6EEBD', fg: '#3B6D11', label: '午餐' },
  snack: { bg: '#FBEAF0', bgStrong: '#F8DAE5', fg: '#993556', label: '加餐' },
  dinner: { bg: '#E6F1FB', bgStrong: '#CFE5F8', fg: '#0C447C', label: '晚餐' },
};

// 一天里的主餐：午餐 + 晚餐。早餐/加餐属于配角，视觉上要退一层。
const MAIN_MEALS = ['lunch', 'dinner'];

function isMainMeal(meal) {
  return MAIN_MEALS.indexOf(meal) >= 0;
}

const WEEKDAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const WARNING_TONE = { error: 'error', warn: 'warn', info: 'info' };

module.exports = { MEAL_STYLE, MAIN_MEALS, isMainMeal, WEEKDAY_TEXT, WARNING_TONE };

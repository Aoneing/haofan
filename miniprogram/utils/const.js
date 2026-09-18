// utils/const.js — 餐次配色与文案常量（与设计文档 6.3 节一致）
const MEAL_STYLE = {
  breakfast: { bg: '#FAEEDA', fg: '#854F0B', label: '早餐' },
  lunch: { bg: '#EAF3DE', fg: '#3B6D11', label: '午餐' },
  snack: { bg: '#FBEAF0', fg: '#993556', label: '加餐' },
  dinner: { bg: '#E6F1FB', fg: '#0C447C', label: '晚餐' },
};

const WEEKDAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const WARNING_TONE = { error: 'error', warn: 'warn', info: 'info' };

module.exports = { MEAL_STYLE, WEEKDAY_TEXT, WARNING_TONE };

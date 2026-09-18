// utils/date.js — 全部以 ISO 字符串（YYYY-MM-DD）为单位运算，避免时区踩坑
const { WEEKDAY_TEXT } = require('./const');

/** 客户端兜底的北京日期（权威值以 menuQuery 返回的 serverToday 为准） */
function beijingToday() {
  const ms = Date.now() + 8 * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** a - b，单位天 */
function diffDays(a, b) {
  return Math.round(
    (new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000
  );
}

function weekdayOf(iso) {
  return new Date(iso + 'T00:00:00Z').getUTCDay();
}

/** "2026-09-20" → "9月20日 周日" */
function fmtCN(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.getUTCMonth() + 1 + '月' + d.getUTCDate() + '日 ' + WEEKDAY_TEXT[d.getUTCDay()];
}

/** "2026-09-20" → "9/20" */
function fmtMD(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.getUTCMonth() + 1 + '/' + d.getUTCDate();
}

/** "9/20 - 9/26" */
function fmtRange(startISO, endISO) {
  return fmtMD(startISO) + ' - ' + fmtMD(endISO);
}

module.exports = { beijingToday, addDays, diffDays, weekdayOf, fmtCN, fmtMD, fmtRange };

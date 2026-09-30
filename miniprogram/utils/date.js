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

/**
 * 历史周期列表右侧的相对标记。
 *
 * 为什么需要它：周期列表按时间倒序铺开，导入越久列表越长，光看「9/29 - 10/5」
 * 分不清哪一期是**现在正在吃的**。给一个相对标记，就能一眼定位到当前期。
 * （放在 date.js 而不是页面里，是为了能单独跑测试。）
 *
 * @param {string} startISO 周期起始日
 * @param {string} endISO 周期结束日（可空）
 * @param {string} [todayISO] 今天，默认取北京日期
 * @returns {{text: string, isCurrent: boolean}} isCurrent 用于高亮
 */
function periodBadge(startISO, endISO, todayISO) {
  const today = todayISO || beijingToday();
  if (!startISO) return { text: '', isCurrent: false };

  // 今天落在该周期内 ⇒ 这就是正在用的那一期
  if (today >= startISO && (!endISO || today <= endISO)) {
    return { text: '在吃', isCurrent: true };
  }
  const d = diffDays(today, startISO); // 今天 - 起始日；>0 表示已过去
  if (d < 0) return { text: '未开始', isCurrent: false };

  // 一个月内按「周」说，比「9月」更能给出距离感
  if (d < 30) {
    const w = Math.floor(d / 7);
    return { text: (w < 1 ? 1 : w) + ' 周前', isCurrent: false };
  }
  // 更早的只说月份；跨年必须带年份，否则「12月」是今年还是去年分不清
  const sy = Number(String(startISO).slice(0, 4));
  const ty = Number(String(today).slice(0, 4));
  const m = Number(String(startISO).slice(5, 7));
  const yearPart = sy !== ty ? String(sy).slice(2) + '年' : '';
  return { text: yearPart + m + '月', isCurrent: false };
}

module.exports = { beijingToday, addDays, diffDays, weekdayOf, fmtCN, fmtMD, fmtRange, periodBadge };

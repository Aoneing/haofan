'use strict';

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

/**
 * 云函数服务器跑 UTC，北京时间 = UTC + 8h。
 * 统一从这里取「今天」，避免手机本地时间被改导致的三态错乱。
 */
function beijingDate(offsetDays) {
  const ms = Date.now() + 8 * 3600 * 1000 + (offsetDays || 0) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function safeGetDay(date) {
  return db
    .collection('days')
    .doc(date)
    .get()
    .then((res) => res.data || null)
    .catch(() => null);
}

async function getPeriodById(periodId) {
  if (!periodId) return null;
  return db
    .collection('periods')
    .doc(periodId)
    .get()
    .then((res) => res.data || null)
    .catch(() => null);
}

/**
 * getContext：首页数据源。
 *  - 今天/明天各自独立查 days 表 —— 跨周时两者可能分属不同周期；
 *  - 两者都无数据时定位三态：
 *      in-period   今天或明天有数据
 *      before      存在 endDate >= 今天的最近周期（即将开始）
 *      after       没有进行中/将来的周期（表已过时，提示导入新表）
 */
async function getContext() {
  const today = beijingDate(0);
  const tomorrow = beijingDate(1);

  const [todayDay, tomorrowDay] = await Promise.all([safeGetDay(today), safeGetDay(tomorrow)]);

  let state = 'in-period';
  let period = null;

  if (todayDay || tomorrowDay) {
    const hit = todayDay || tomorrowDay;
    period = await getPeriodById(hit.periodId);
  } else {
    const upcoming = await db
      .collection('periods')
      .where({ endDate: _.gte(today) })
      .orderBy('startDate', 'asc')
      .limit(1)
      .get();
    if (upcoming.data.length) {
      state = 'before';
      period = upcoming.data[0];
    } else {
      state = 'after';
      const last = await db.collection('periods').orderBy('endDate', 'desc').limit(1).get();
      period = last.data[0] || null;
    }
  }

  return {
    ok: true,
    state,
    serverToday: today,
    serverTomorrow: tomorrow,
    today: todayDay,
    tomorrow: tomorrowDay,
    period,
  };
}

/**
 * getWeek：按 periodId（优先）/ date / 无参回退，返回周期 + 7 天。
 * 无参回退顺序：进行中或最近的将来周期 → 最近一期历史周期。
 * （一周 tab 首次进入时没有 periodId，必须能落到「该看的那一周」，而不是报 NOT_FOUND）
 */
async function getWeek(event) {
  let period = null;

  if (event.periodId) {
    period = await getPeriodById(event.periodId);
  } else if (event.date) {
    const dayRes = await db
      .collection('days')
      .where({ date: event.date })
      .limit(1)
      .get();
    period = dayRes.data.length ? await getPeriodById(dayRes.data[0].periodId) : null;
  } else {
    // 无参：先找「尚未结束」的最近一期（含进行中与将来），退而求其次取最近的历史周期
    const today = beijingDate(0);
    const upcoming = await db
      .collection('periods')
      .where({ endDate: _.gte(today) })
      .orderBy('startDate', 'asc')
      .limit(1)
      .get();
    if (upcoming.data.length) {
      period = upcoming.data[0];
    } else {
      const last = await db
        .collection('periods')
        .orderBy('endDate', 'desc')
        .limit(1)
        .get();
      period = last.data[0] || null;
    }
  }

  if (!period) {
    return { ok: false, code: 'NOT_FOUND', message: '还没有任何食谱周期，请先导入一份周食谱' };
  }

  const daysRes = await db
    .collection('days')
    .where({ periodId: period._id })
    .orderBy('dayIndex', 'asc')
    .limit(7)
    .get();

  return {
    ok: true,
    period,
    days: daysRes.data,
    serverToday: beijingDate(0),
    fallback: !event.periodId && !event.date,
  };
}

/** getDay：单日详情（含所属周期，供页面展示「本周菜单」入口） */
async function getDay(event) {
  if (!event.date || !/^\d{4}-\d{2}-\d{2}$/.test(event.date)) {
    return { ok: false, message: '缺少 date（YYYY-MM-DD）' };
  }
  const day = await safeGetDay(event.date);
  if (!day) {
    return { ok: false, code: 'NOT_FOUND', message: '这一天没有食谱数据' };
  }
  const period = await getPeriodById(day.periodId);
  return { ok: true, day, period, serverToday: beijingDate(0) };
}

/** listPeriods：我的页 — 历史周期列表 */
async function listPeriods(event) {
  const limit = Math.min(Number(event.limit) || 20, 50);
  const res = await db.collection('periods').orderBy('startDate', 'desc').limit(limit).get();
  return { ok: true, periods: res.data };
}

exports.main = async (event) => {
  try {
    const action = event && event.action;
    switch (action) {
      case 'getContext':
        return await getContext();
      case 'getWeek':
        return await getWeek(event || {});
      case 'getDay':
        return await getDay(event || {});
      case 'listPeriods':
        return await listPeriods(event || {});
      default:
        return { ok: false, message: '未知 action：' + action };
    }
  } catch (e) {
    console.error('[menuQuery] failed', e);
    return { ok: false, message: '查询失败：' + (e && e.message ? e.message : '未知错误') };
  }
};

'use strict';

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const DAY_FIELDS = [
  'date',
  'weekday',
  'weekdayText',
  'dayIndex',
  'meals',
  'prepNotes',
  'globalPrep',
];
const PERIOD_FIELDS = [
  'startDate',
  'endDate',
  'startWeekday',
  'startWeekdayText',
  'rawRangeText',
  'yearAssumed',
];

function pick(obj, fields) {
  const out = {};
  fields.forEach((f) => {
    if (obj[f] !== undefined) out[f] = obj[f];
  });
  return out;
}

/**
 * 把人工校对后的解析结果落库（幂等 upsert）。
 * 设计要点：
 *  - periods._id = "startDate~endDate"，同一份表重复导入不会产生脏数据
 *  - days._id = ISO 日期，一天一条，今天/明天查询都是 O(1) doc get
 *  - 写入前做周期重叠检测：新周期与已有周期相交时，默认拒绝，由前端弹窗确认后
 *    以 mode='overwrite' 重试（避免旧表覆盖新表导致「今天」页错乱）
 *
 * 入参：{ period, days, stats?, mode? }   mode: 'ask'（默认）| 'overwrite'
 * 出参：{ ok, periodId, savedDays } | { ok:false, code:'PERIOD_OVERLAP', overlapping }
 */
exports.main = async (event) => {
  try {
    const { period, days, stats, mode } = event || {};
    const effectiveMode = mode === 'overwrite' ? 'overwrite' : 'ask';

    if (!period || !period.startDate || !period.endDate) {
      return { ok: false, message: '缺少 period（startDate/endDate）' };
    }
    if (!Array.isArray(days) || days.length !== 7) {
      return { ok: false, message: 'days 必须是恰好 7 天的数组' };
    }
    for (let i = 0; i < days.length; i++) {
      if (!days[i] || !/^\d{4}-\d{2}-\d{2}$/.test(days[i].date || '')) {
        return { ok: false, message: `第 ${i + 1} 天缺少合法 date（YYYY-MM-DD）` };
      }
    }

    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID || 'anonymous';
    const periodId = period.startDate + '~' + period.endDate;
    const now = db.serverDate();

    // 1) 周期重叠检测：[s1,e1] 与 [s2,e2] 相交 ⇔ s1 <= e2 && e1 >= s2
    const overlapRes = await db
      .collection('periods')
      .where({
        startDate: _.lte(period.endDate),
        endDate: _.gte(period.startDate),
      })
      .limit(20)
      .get();
    const overlapping = overlapRes.data.filter((p) => p._id !== periodId);
    if (overlapping.length && effectiveMode !== 'overwrite') {
      return {
        ok: false,
        code: 'PERIOD_OVERLAP',
        message: `与已有 ${overlapping.length} 个食谱周期重叠，需确认覆盖`,
        overlapping,
      };
    }

    // 2) 清理被本次导入「顶掉」的旧周期残留。
    // 场景：旧周期 9/20-9/26 已入库，新导入 9/22-9/28 选覆盖 ——
    //   9/22~9/26 会被新周期的 days 覆盖（同 _id），
    //   但 9/20、9/21 仍挂在旧 periodId 下，成为孤儿数据。
    //   getContext 用 days._id 直接取「今天」，孤儿天会让首页显示已不存在的周期内容；
    //   getWeek 按 periodId 查又会查出残缺的一周。
    // 处理：对每个被覆盖的旧周期，删掉它名下所有不属于新周期日期范围的天。
    const replacedDays = [];
    if (overlapping.length) {
      const newDates = days.map((d) => d.date);
      for (const p of overlapping) {
        const oldDays = await db
          .collection('days')
          .where({ periodId: p._id })
          .limit(20)
          .get();
        const orphans = oldDays.data.filter((doc) => newDates.indexOf(doc.date) < 0);
        await Promise.all(
          orphans.map((doc) =>
            db
              .collection('days')
              .doc(doc.date)
              .remove()
              .catch(() => null)
          )
        );
        orphans.forEach((doc) => replacedDays.push(doc.date));
        if (orphans.length) {
          console.log('[menuSave] 清理旧周期 ' + p._id + ' 的孤儿天：' + orphans.map((d) => d.date).join(','));
        }
      }
    }

    // 3) upsert 周期文档
    const periodDoc = pick(period, PERIOD_FIELDS);
    if (stats) periodDoc.stats = stats;
    periodDoc.updatedAt = now;
    periodDoc.openid = openid;
    await db.collection('periods').doc(periodId).set({ data: periodDoc });

    // 4) upsert 7 天文档
    await Promise.all(
      days.map((day) => {
        const dayDoc = pick(day, DAY_FIELDS);
        dayDoc.periodId = periodId;
        dayDoc.updatedAt = now;
        dayDoc.openid = openid;
        return db.collection('days').doc(dayDoc.date).set({ data: dayDoc });
      })
    );

    // 5) 被覆盖的旧周期若已完全失去天文档，一并清掉周期记录，避免「我的」页留下空周期
    const removedPeriods = [];
    if (overlapping.length) {
      for (const p of overlapping) {
        const left = await db
          .collection('days')
          .where({ periodId: p._id })
          .limit(1)
          .get();
        if (!left.data.length) {
          await db
            .collection('periods')
            .doc(p._id)
            .remove()
            .catch(() => null);
          removedPeriods.push(p._id);
        }
      }
    }

    return {
      ok: true,
      periodId,
      savedDays: days.length,
      overwritten: overlapping.length > 0,
      removedDays: replacedDays,
      removedPeriods,
    };
  } catch (e) {
    console.error('[menuSave] failed', e);
    return { ok: false, message: '保存失败：' + (e && e.message ? e.message : '未知错误') };
  }
};

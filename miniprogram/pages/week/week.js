// pages/week/week.js — 一周视图：日期条切换 + 当天色卡
//
// 与上一版的差别：上一版把七天的卡片全部铺开、靠滚动联动定位，
// 页面很长、吸顶条要重测布局；这一版改成「日期条选哪天就只看哪天」，
// 和定稿图一致，也顺带消掉了滚动测量那一套时序（展开动画后再测高）。
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dateUtil = require('../../utils/date');
const dishNav = require('../../utils/dishNav');

Page({
  data: {
    loading: true,
    notFound: false,
    period: null,
    periodRange: '',
    days: [], // [{ day, highlight }] —— 原始七日，颜色卡按当前选中日现算
    navDays: [], // [{ date, weekdayText, dayNum, isToday }]
    activeIndex: 0,
    activeDay: null,
    activeDateText: '',
    tiles: [],
    morningPrep: null,
    eveningPrep: null,
    weeklyPrep: null,
    serverToday: '',
    expandedUid: '',
  },

  onShow() {
    if (this.getTabBar && this.getTabBar()) {
      this.getTabBar().setActive('/pages/week/week');
    }
    // import 完成页 / 我的页 会通过 globalData 指定要看的周期（tabBar 页无法带参）
    const app = getApp();
    const pending = app.globalData.pendingWeekPeriodId;
    if (pending) {
      delete app.globalData.pendingWeekPeriodId;
      this.load(pending);
    } else {
      this.load(this.data.period && this.data.period._id);
    }
  },

  onPullDownRefresh() {
    this.load(this.data.period && this.data.period._id).then(() =>
      wx.stopPullDownRefresh()
    );
  },

  async load(periodId) {
    this.setData({ loading: true, notFound: false });
    try {
      const res = await api.query('getWeek', periodId ? { periodId } : {});
      if (!res.ok) {
        if (res.code === 'NOT_FOUND') {
          this.setData({ loading: false, notFound: true });
          return;
        }
        throw new Error(res.message || '查询失败');
      }

      const keys = [];
      res.days.forEach((d) =>
        (d.meals || []).forEach((m) => (m.dishKeys || []).forEach((k) => k && keys.push(k)))
      );
      await imageStore.hydrate(keys);

      const today = res.serverToday;
      const days = res.days.map((d) => ({
        day: d,
        highlight: d.date === today ? 'today' : d.date === dateUtil.addDays(today, 1) ? 'tomorrow' : '',
      }));

      // 日期条：星期全称 + 日号；今天所在位置预选中
      const navDays = days.map((x) => ({
        date: x.day.date,
        weekdayText: x.day.weekdayText || '',
        dayNum: Number(String(x.day.date).slice(8, 10)),
        isToday: x.day.date === today,
      }));

      // 周期被换掉时才回到今天；同周期内切来切去要保留用户选的那天
      const pid = res.period && res.period._id;
      const samePeriod = pid === this._shownPeriodId;
      let idx = samePeriod ? this.data.activeIndex : navDays.findIndex((x) => x.isToday);
      if (idx < 0 || idx >= navDays.length) idx = 0;
      this._shownPeriodId = pid;

      this.setData(
        {
          loading: false,
          period: res.period,
          periodRange: dateUtil.fmtRange(res.period.startDate, res.period.endDate),
          days,
          navDays,
          serverToday: today,
        },
        () => this.applyActive(idx, today)
      );
    } catch (e) {
      this.setData({ loading: false, notFound: true, errMsg: e.message });
    }
  },

  /** 把第 i 天的数据铺到当前视图（色卡 + 备料条） */
  applyActive(i, today) {
    const item = this.data.days[i];
    const day = item && item.day;
    const prep = buildPrepCards(day);
    this.setData({
      activeIndex: i,
      activeDay: day,
      // 选中日是否今天直接并进标题（hero 已移除，别丢「当前是今天」的提示）
      activeDateText: day ? dateUtil.fmtCN(day.date) + (day.date === today ? ' · 今天' : '') : '',
      tiles: withUid(day),
      morningPrep: prep.morningPrep,
      eveningPrep: prep.eveningPrep,
      weeklyPrep: prep.weeklyPrep,
      expandedUid: '',
    });
  },

  onNavTap(e) {
    const i = Number(e.currentTarget.dataset.index);
    if (!this.data.navDays[i]) return;
    this.applyActive(i, this.data.serverToday);
  },

  /** 点色卡：先展开做法，再点进详情 */
  onTileTap(e) {
    const { key, uid, title, recipe } = e.detail;
    if (!key) return;
    if (this.data.expandedUid !== uid) {
      this.setData({ expandedUid: uid });
      return;
    }
    dishNav.put(key, { recipe: recipe || '' });
    wx.navigateTo({
      url: '/pages/dish/dish?key=' + encodeURIComponent(key) + '&title=' + encodeURIComponent(title || ''),
    });
  },

  goActiveDetail() {
    if (this.data.activeDay) {
      wx.navigateTo({ url: '/pages/day/day?date=' + this.data.activeDay.date });
    }
  },

  goImport() {
    wx.navigateTo({ url: '/pages/import/import' });
  },
});

/** 与今日页同款：给每餐补一个稳定 uid，避免同名菜在展开态上互相牵连 */
function withUid(day) {
  if (!day) return [];
  return (day.meals || []).map((m, i) =>
    Object.assign({}, m, {
      uid: m.meal + '-' + (m.slot || i) + '-' + ((m.dishKeys && m.dishKeys[0]) || 'empty'),
    })
  );
}

/**
 * 备料拆成「早 / 晚」两张卡，外加「整周备料」一张（仅当天是周日才出现）。
 * 与今日页同款逻辑，抽成独立函数避免两份实现 drift。
 */
function buildPrepCards(day) {
  if (!day) return { morningPrep: null, eveningPrep: null, weeklyPrep: null };
  const notes = day.prepNotes || [];
  const morning = notes.filter((p) => p.timing === 'morning');
  const evening = notes.filter((p) => p.timing !== 'morning');
  const weekly = Object.keys(day.globalPrep || {}).map((k) => ({
    label: k,
    stepsText: day.globalPrep[k],
  }));
  return {
    morningPrep: morning.length
      ? { timing: 'morning', title: '早 · 备料', items: morning.map(toPrepItem) }
      : null,
    eveningPrep: evening.length
      ? { timing: 'evening', title: '晚 · 备料', items: evening.map(toPrepItem) }
      : null,
    weeklyPrep:
      day.weekday === 0 && weekly.length
        ? { timing: 'weekly', title: '整周备料', items: weekly }
        : null,
  };
}

/** 备料项 → 卡片条目 */
function toPrepItem(p) {
  const stepsText =
    (p.steps && p.steps.length ? p.steps.join('；') : p.rawText || '') || '';
  return { label: p.label, stepsText };
}
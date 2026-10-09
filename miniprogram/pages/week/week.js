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
    } else if (!this._inited) {
      // 首次进入全量加载（带骨架）；之后切回走静默刷新，不闪空白
      this._inited = true;
      this.load(this.data.period && this.data.period._id);
    } else {
      this.load(this.data.period && this.data.period._id, true);
    }
  },

  onPullDownRefresh() {
    this.load(this.data.period && this.data.period._id).then(() =>
      wx.stopPullDownRefresh()
    );
  },

  async load(periodId, silent) {
    // 静默刷新：已加载过就不闪 loading，直接后台拿新数据替换
    if (!silent) this.setData({ loading: true, notFound: false });
    try {
      const res = await api.query('getWeek', periodId ? { periodId } : {});
      if (!res.ok) {
        if (res.code === 'NOT_FOUND') {
          if (silent) return; // 静默刷新：找不到就沿用旧数据，不闪空态
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
        () => this.applyActive(idx, today, silent)
      );
    } catch (e) {
      if (silent) {
        // 静默刷新失败：沿用旧数据，下次再试
        console.warn('[week] 静默刷新失败，沿用旧数据：', e.message);
        return;
      }
      this.setData({ loading: false, notFound: true, errMsg: e.message });
    }
  },

  /** 把第 i 天的数据铺到当前视图（色卡 + 备料条）
   * @param {boolean} preserveExpand 静默刷新时保留当前展开的色卡，别切回就收起 */
  applyActive(i, today, preserveExpand) {
    const item = this.data.days[i];
    const day = item && item.day;
    const prep = buildPrepCards(day);
    const activeDateText = day
      ? dateUtil.fmtCN(day.date) + (day.date === today ? ' · 今天' : '')
      : '';
    const patch = {
      activeIndex: i,
      activeDay: day,
      activeDateText,
      tiles: withUid(day),
      morningPrep: prep.morningPrep,
      eveningPrep: prep.eveningPrep,
      weeklyPrep: prep.weeklyPrep,
    };
    // 用户手动点某天切换时（preserveExpand 为假）照旧收起展开态；
    // 静默刷新（真）则保留，避免切回 tab 后展开态莫名其妙消失。
    if (!preserveExpand) patch.expandedUid = '';
    this.setData(patch);
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
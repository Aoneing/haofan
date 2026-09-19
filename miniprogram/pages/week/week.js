// pages/week/week.js — 一周视图
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dateUtil = require('../../utils/date');

// 滚动定位 / 联动判定都按「吸顶条下方一点点」算，避免标题被吸顶条盖住
const ANCHOR_GAP = 12;
// 顶部大标题折起的滚动阈值（px）
const HEADER_FOLD = 56;
// 展开动画时长：等它结束再重新测量，否则会测到中间态
const EXPAND_ANIM_MS = 450;

Page({
  data: {
    loading: true,
    notFound: false,
    period: null,
    periodRange: '',
    days: [], // [{ day, images, highlight }]
    navDays: [], // [{ date, weekdayText, isToday }] — 导航只显示周几，日期走吸顶小字
    serverToday: '',
    // —— 吸顶导航 + 滚动联动 ——
    activeIndex: 0, // 当前正在看的那一天（滚动自动更新，不只是点击）
    activeDayText: '', // 吸顶条上的日期小字，如「周三 9/23」
    headerFolded: false, // 顶部大标题是否已滚出（仅用于吸顶阴影反馈）
    dayTops: [], // 各日卡片相对文档的 top（px）
    stickyH: 0, // 吸顶条高度（px）
  },

  onShow() {
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

  onUnload() {
    clearTimeout(this._measureTimer);
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
        images: pickImages(d),
        highlight: d.date === today ? 'today' : d.date === dateUtil.addDays(today, 1) ? 'tomorrow' : '',
      }));

      // 星期导航：每次打开默认选中今天；今天不在本期时退回第一天
      let selIndex = days.findIndex((x) => x.day.date === today);
      if (selIndex < 0) selIndex = 0;
      const navDays = days.map((x) => ({
        date: x.day.date,
        weekdayText: (x.day.weekdayText || '').slice(-1), // 「周日」→「日」
        isToday: x.day.date === today,
      }));

      const pid = res.period && res.period._id;
      const shouldLocate = this._locatedFor !== pid;

      this.setData(
        {
          loading: false,
          period: res.period,
          periodRange: dateUtil.fmtRange(res.period.startDate, res.period.endDate),
          days,
          navDays,
          serverToday: today,
          activeIndex: selIndex,
          activeDayText: dayLabel(days[selIndex], today),
          headerFolded: false,
        },
        () => {
          // 渲染完先测量布局，再决定要不要自动定位到今天
          this.measureLayout(() => {
            if (shouldLocate) {
              this._locatedFor = pid;
              this.scrollToDay(selIndex, 0); // 首次进入直接到位，不做动画
            }
          });
        }
      );
    } catch (e) {
      this.setData({ loading: false, notFound: true, errMsg: e.message });
    }
  },

  /* ---------- 吸顶 + 联动 ---------- */

  /** 测量各日卡片位置与吸顶条高度（展开后高度会变，需要重测） */
  measureLayout(done) {
    const n = this.data.days.length;
    if (!n) {
      if (done) done();
      return;
    }
    const q = wx.createSelectorQuery().in(this);
    for (let i = 0; i < n; i++) q.select('#day-' + i).boundingClientRect();
    q.select('.wk-sticky').boundingClientRect();
    q.selectViewport().scrollOffset();
    q.exec((res) => {
      const scrollTop = (res[n + 1] && res[n + 1].scrollTop) || 0;
      const tops = [];
      for (let i = 0; i < n; i++) {
        tops.push(res[i] ? res[i].top + scrollTop : 0);
      }
      const sticky = res[n];
      this.setData(
        { dayTops: tops, stickyH: sticky ? sticky.height : 0 },
        () => {
          if (done) done();
        }
      );
    });
  },

  /** 滚动到某一天（留出吸顶条高度） */
  scrollToDay(i, duration) {
    const tops = this.data.dayTops;
    if (!tops || typeof tops[i] !== 'number') return;
    const top = Math.max(0, tops[i] - (this.data.stickyH || 0) - ANCHOR_GAP);
    wx.pageScrollTo({
      scrollTop: top,
      duration: duration || 300,
      fail: () => {}, // 低版本基础库不支持时静默降级
    });
  },

  /** 当前视口顶部落在哪一天 */
  pickActiveIndex(scrollTop) {
    const tops = this.data.dayTops || [];
    if (!tops.length) return 0;
    const anchor = scrollTop + (this.data.stickyH || 0) + ANCHOR_GAP;
    let idx = 0;
    for (let i = 0; i < tops.length; i++) {
      if (tops[i] <= anchor) idx = i;
    }
    return idx;
  },

  onPageScroll(e) {
    const st = e.scrollTop;
    const patch = {};
    const folded = st > HEADER_FOLD;
    if (folded !== this.data.headerFolded) patch.headerFolded = folded;
    const idx = this.pickActiveIndex(st);
    if (idx !== this.data.activeIndex) {
      patch.activeIndex = idx;
      patch.activeDayText = dayLabel(this.data.days[idx], this.data.serverToday);
    }
    // 只在状态真的变了才 setData，避免滚动时高频渲染
    if (Object.keys(patch).length) this.setData(patch);
  },

  /** 点星期导航：立即高亮 + 平滑滚动到对应日卡片 */
  onNavTap(e) {
    const i = Number(e.currentTarget.dataset.index);
    if (!this.data.navDays[i]) return;
    this.setData({
      activeIndex: i,
      activeDayText: dayLabel(this.data.days[i], this.data.serverToday),
    });
    this.scrollToDay(i, 300);
  },

  /** 卡片展开会改变高度，等动画结束重测布局 */
  onCardExpand() {
    clearTimeout(this._measureTimer);
    this._measureTimer = setTimeout(() => this.measureLayout(), EXPAND_ANIM_MS);
  },

  onDayTap(e) {
    wx.navigateTo({ url: '/pages/day/day?date=' + e.detail.date });
  },

  onDishTap(e) {
    const { key, title } = e.detail;
    if (!key) return;
    wx.navigateTo({
      url: '/pages/dish/dish?key=' + encodeURIComponent(key) + '&title=' + encodeURIComponent(title || ''),
    });
  },

  goImport() {
    wx.navigateTo({ url: '/pages/import/import' });
  },
});

function dayLabel(item, today) {
  if (!item) return '';
  const d = item.day;
  const base = (d.weekdayText || '') + ' ' + dateUtil.fmtMD(d.date);
  return d.date === today ? base + ' · 今天' : base;
}

function pickImages(day) {
  const map = {};
  (day.meals || []).forEach((m) => {
    const k = m.dishKeys && m.dishKeys[0];
    if (k) {
      const u = imageStore.get(k);
      if (u) map[k] = u;
    }
  });
  return map;
}

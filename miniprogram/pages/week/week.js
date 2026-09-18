// pages/week/week.js — 一周视图
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dateUtil = require('../../utils/date');

Page({
  data: {
    loading: true,
    notFound: false,
    period: null,
    periodRange: '',
    days: [], // [{ day, images, highlight }]
    navDays: [], // [{ date, weekdayText, dateText, isToday, selected }]
    serverToday: '',
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
      const navDays = days.map((x, i) => ({
        date: x.day.date,
        weekdayText: (x.day.weekdayText || '').slice(-1), // 「周日」→「日」
        dateText: dateUtil.fmtMD(x.day.date),
        isToday: x.day.date === today,
        selected: i === selIndex,
      }));

      this.setData({
        loading: false,
        period: res.period,
        periodRange: dateUtil.fmtRange(res.period.startDate, res.period.endDate),
        days,
        navDays,
        serverToday: today,
      });
    } catch (e) {
      this.setData({ loading: false, notFound: true, errMsg: e.message });
    }
  },

  onDayTap(e) {
    wx.navigateTo({ url: '/pages/day/day?date=' + e.detail.date });
  },

  /** 点星期导航：切换选中块 + 平滑滚动到对应日卡片 */
  onNavTap(e) {
    const i = Number(e.currentTarget.dataset.index);
    const target = this.data.navDays[i];
    if (!target || target.selected) return;
    const patch = {};
    this.data.navDays.forEach((n, j) => {
      patch['navDays[' + j + '].selected'] = j === i;
    });
    this.setData(patch);
    wx.pageScrollTo({
      selector: '#day-' + i,
      offsetTop: -16,
      duration: 300,
      fail: () => {}, // 低版本基础库不支持 selector 时静默降级
    });
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

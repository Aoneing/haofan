// pages/today/today.js — 首页：今天 / 明天 / 三态
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dateUtil = require('../../utils/date');

Page({
  data: {
    loading: true,
    state: '', // in-period | before | after | error
    errMsg: '',
    todayText: '',
    periodRange: '',
    periodId: '',
    todayDay: null,
    todayImages: {},
    tomorrowDay: null,
    tomorrowImages: {},
    beforeText: '',
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    try {
      const res = await api.query('getContext');
      if (!res.ok) throw new Error(res.message || '查询失败');

      const data = {
        loading: false,
        state: res.state,
        errMsg: '',
        periodId: res.period ? res.period._id : '',
        todayText: res.serverToday ? dateUtil.fmtCN(res.serverToday) : '',
        periodRange:
          res.period ? dateUtil.fmtRange(res.period.startDate, res.period.endDate) : '',
        todayDay: null,
        todayImages: {},
        tomorrowDay: null,
        tomorrowImages: {},
        beforeText: '',
      };

      if (res.state === 'in-period') {
        const keys = [];
        collectKeys(res.today, keys);
        collectKeys(res.tomorrow, keys);
        await imageStore.hydrate(keys);
        data.todayDay = res.today;
        data.todayImages = pickImages(res.today);
        data.tomorrowDay = res.tomorrow;
        data.tomorrowImages = pickImages(res.tomorrow);
      } else if (res.state === 'before' && res.period) {
        // 距离开饭天数 = 周期开始日 - 今天（服务端日期为准）
        const d = dateUtil.diffDays(res.period.startDate, res.serverToday);
        if (d > 1) data.beforeText = '距离开饭还有 ' + d + ' 天';
        else if (d === 1) data.beforeText = '明天就开饭啦 🍚';
        else if (d === 0) data.beforeText = '今天开饭 🍚';
        // d < 0 说明服务端判定为 before 但开始日已过，属数据不一致，给出中性文案兜底
        else data.beforeText = '新一期食谱已就绪';
      }
      this.setData(data);
    } catch (e) {
      this.setData({ loading: false, state: 'error', errMsg: e.message });
    }
  },

  /* 跳转 */
  goWeek() {
    // 带上当前周期，避免一周页按「最近未结束周期」回退到别的周
    if (this.data.periodId) {
      getApp().globalData.pendingWeekPeriodId = this.data.periodId;
    }
    wx.switchTab({ url: '/pages/week/week' });
  },
  goImport() {
    wx.navigateTo({ url: '/pages/import/import' });
  },
  goTodayDetail() {
    if (this.data.todayDay) {
      wx.navigateTo({ url: '/pages/day/day?date=' + this.data.todayDay.date });
    }
  },
  goTomorrowDetail() {
    if (this.data.tomorrowDay) {
      wx.navigateTo({ url: '/pages/day/day?date=' + this.data.tomorrowDay.date });
    }
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
  onErrorRetry() {
    this.load();
  },
});

function collectKeys(day, out) {
  if (!day) return;
  (day.meals || []).forEach((m) => {
    (m.dishKeys || []).forEach((k) => {
      if (k) out.push(k);
    });
  });
}

function pickImages(day) {
  const map = {};
  if (!day) return map;
  (day.meals || []).forEach((m) => {
    const k = m.dishKeys && m.dishKeys[0];
    if (k) {
      const u = imageStore.get(k);
      if (u) map[k] = u;
    }
  });
  return map;
}

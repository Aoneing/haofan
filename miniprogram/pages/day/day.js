// pages/day/day.js — 单日详情
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dateUtil = require('../../utils/date');

Page({
  data: {
    loading: true,
    notFound: false,
    date: '',
    dateText: '',
    day: null,
    images: {},
    periodId: '',
    isToday: false,
  },

  onLoad(options) {
    this.setData({ date: options.date || '' });
  },

  onShow() {
    if (this.data.date) this.load(this.data.date);
  },

  async load(date) {
    this.setData({ loading: true });
    try {
      const res = await api.query('getDay', { date });
      if (!res.ok) {
        if (res.code === 'NOT_FOUND') {
          this.setData({ loading: false, notFound: true });
          return;
        }
        throw new Error(res.message || '查询失败');
      }

      const keys = [];
      (res.day.meals || []).forEach((m) =>
        (m.dishKeys || []).forEach((k) => k && keys.push(k))
      );
      await imageStore.hydrate(keys);

      const images = {};
      (res.day.meals || []).forEach((m) => {
        const k = m.dishKeys && m.dishKeys[0];
        if (k) {
          const u = imageStore.get(k);
          if (u) images[k] = u;
        }
      });

      // 注意：setData 是异步的，标题必须用本地变量判断，不能回头读 this.data.isToday
      const isToday = res.day.date === res.serverToday;
      this.setData({
        loading: false,
        day: res.day,
        images,
        periodId: res.period ? res.period._id : '',
        dateText: dateUtil.fmtCN(date),
        isToday,
      });
      wx.setNavigationBarTitle({ title: isToday ? '今天吃什么' : '那天吃什么' });
    } catch (e) {
      this.setData({ loading: false, notFound: true, errMsg: e.message });
    }
  },

  onDishTap(e) {
    const { key, title } = e.detail;
    if (!key) return;
    wx.navigateTo({
      url: '/pages/dish/dish?key=' + encodeURIComponent(key) + '&title=' + encodeURIComponent(title || ''),
    });
  },

  goWeek() {
    const app = getApp();
    if (this.data.periodId) app.globalData.pendingWeekPeriodId = this.data.periodId;
    wx.switchTab({ url: '/pages/week/week' });
  },
});

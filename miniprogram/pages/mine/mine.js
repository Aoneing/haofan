// pages/mine/mine.js — 我的：数据统计、历史周期、关于
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dateUtil = require('../../utils/date');

Page({
  data: {
    loading: true,
    periods: [], // [{ _id, rangeText, updatedAtText }]
    dishTotal: 0,
    envError: '',
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    const data = { loading: false, envError: '', periods: [], dishTotal: 0 };
    try {
      const [pRes, sRes] = await Promise.all([
        api.query('listPeriods', { limit: 20 }),
        api.image('stats').catch(() => null),
      ]);
      if (pRes.ok) {
        data.periods = pRes.periods.map((p) => ({
          _id: p._id,
          startDate: p.startDate,
          rangeText: dateUtil.fmtRange(p.startDate, p.endDate) + '（' + p.startWeekdayText + '打头）',
        }));
      } else {
        data.envError = pRes.message || '';
      }
      if (sRes && sRes.ok) data.dishTotal = sRes.total;
    } catch (e) {
      data.envError = e.message || '云函数调用失败：请确认已部署云函数并正确配置环境 ID';
    }
    this.setData(data);
  },

  onPeriodTap(e) {
    getApp().globalData.pendingWeekPeriodId = e.currentTarget.dataset.id;
    wx.switchTab({ url: '/pages/week/week' });
  },

  goImport() {
    wx.navigateTo({ url: '/pages/import/import' });
  },

  clearCache() {
    imageStore.clear();
    wx.showToast({ title: '已清除', icon: 'success' });
  },
});

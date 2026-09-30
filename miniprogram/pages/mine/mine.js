// pages/mine/mine.js — 我的：数据统计、历史周期、食材处理、关于
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dateUtil = require('../../utils/date');
const prepData = require('../../utils/ingredientPrep');

Page({
  data: {
    loading: true,
    periods: [], // [{ _id, rangeText, updatedAtText }]
    dishTotal: 0,
    dishImageError: '', // 「张配图」取数失败时的提示：以前静默 catch 成 0，看着像真没图
    envError: '',
    // 食材处理手册：静态数据，手风琴一次只展开一个（内容长，全展开会把页面撑爆）
    prep: {
      title: prepData.title,
      source: prepData.source,
      updatedAt: prepData.updatedAt,
      groups: prepData.groups,
    },
    prepOpenIndex: -1,
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    const data = { loading: false, envError: '', dishImageError: '', periods: [], dishTotal: 0 };
    try {
      const [pRes, sRes] = await Promise.all([
        api.query('listPeriods', { limit: 20 }),
        // 失败不再静默 catch 成 null：那会让「张配图」显示 0，看起来像一张图都没生成过，
        // 而真实原因可能只是 dishImage 没部署（2026-09-30 吃过的误导）。
        api.image('stats').catch((e) => ({ ok: false, message: (e && e.message) || '调用失败' })),
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
      if (sRes && sRes.ok) {
        data.dishTotal = sRes.total;
      } else {
        data.dishImageError = '配图数取不到：' + ((sRes && sRes.message) || 'dishImage 可能未部署');
      }
    } catch (e) {
      data.envError = e.message || '云函数调用失败：请确认已部署云函数并正确配置环境 ID';
    }
    this.setData(data);
  },

  /** 食材处理：点标题展开/收起。一次只开一个，点已展开的则收起 */
  togglePrep(e) {
    const idx = Number(e.currentTarget.dataset.index);
    this.setData({ prepOpenIndex: this.data.prepOpenIndex === idx ? -1 : idx });
  },

  /** 长按某一步可复制文字（做菜时手上有油，常要发给家人或记到别处） */
  copyPrepStep(e) {
    const { gindex, sindex } = e.currentTarget.dataset;
    const g = this.data.prep.groups[Number(gindex)];
    const s = g && g.steps[Number(sindex)];
    if (!s) return;
    wx.setClipboardData({
      data: g.name + ' · ' + s.title + '：' + s.text,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    });
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

// pages/ingredient/ingredient.js — 食材：食材处理手册（独立 tab）
//
// 2026-10-07 从「我的」页抽出来单独成 tab：
// 之前的痛点——「食材处理」挤在「我的」里，和统计数据、历史周期堆在一起，
// 一进个人中心就被一堆不相干的内容顶到屏幕外；而它本身是高频查阅的内容页，
// 不该藏在某页下半截。单独成 tab 后，查阅路径变短，也和其他内容 tab（今日/一周）并列。
const prepData = require('../../utils/ingredientPrep');

Page({
  data: {
    // 食材处理手册：静态数据，手风琴一次只展开一个（内容长，全展开会把页面撑爆）
    prep: {
      title: prepData.title,
      source: prepData.source,
      updatedAt: prepData.updatedAt,
      // 每类算出「步骤概述」：去腥/腌制/煎/回锅，喂给卡片胶囊
      groups: prepData.groups.map((g) => ({
        name: g.name,
        steps: g.steps,
        overview: g.steps.map((s) => s.title).join('/'),
      })),
    },
    prepOpenIndex: -1,
  },

  onShow() {
    // 自绘 tabBar 不会自动同步选中态，每次进来都要自己报一次
    if (this.getTabBar && this.getTabBar()) {
      this.getTabBar().setActive('/pages/ingredient/ingredient');
    }
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
});


// pages/mine/mine.js — 我的：数据统计、历史周期、食材处理、关于
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dateUtil = require('../../utils/date');
const prepData = require('../../utils/ingredientPrep');

/**
 * 历史周期默认只露最近几期。
 * 为什么：每导入一次就多一行，攒到十几期后这一块能把「食材处理」「小工具」全顶到屏幕外，
 * 而用户真正常点的只有最近一两期。默认收起 + 一键展开，两头都照顾到。
 */
const PERIOD_PREVIEW = 3;
/** 向云函数要多少期（云函数侧上限 50，再多也只会静默截断） */
const PERIOD_LIMIT = 50;

Page({
  data: {
    loading: true,
    // 注意两个数组别混用：periodsAll 是全集，periodsShown 是当前渲染的子集。
    // ★ 顶部的「期食谱」计数必须取 periodTotal（全集长度）——
    //   早期版本直接用渲染数组的长度，一折叠统计就跟着变成 3 了。
    periodsAll: [], // [{ _id, rangeText, badgeText, isCurrent }]
    periodsShown: [],
    periodExpanded: false,
    periodTotal: 0,
    periodTruncated: false, // 拿满了上限 ⇒ 还有更早的没显示
    periodPreview: PERIOD_PREVIEW, // 给 wxml 拼「还有 N 期」用
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
    const data = {
      loading: false,
      envError: '',
      dishImageError: '',
      periodsAll: [],
      periodsShown: [],
      periodExpanded: false,
      periodTotal: 0,
      periodTruncated: false,
      dishTotal: 0,
    };
    try {
      const [pRes, sRes] = await Promise.all([
        api.query('listPeriods', { limit: PERIOD_LIMIT }),
        // 失败不再静默 catch 成 null：那会让「张配图」显示 0，看起来像一张图都没生成过，
        // 而真实原因可能只是 dishImage 没部署（2026-09-30 吃过的误导）。
        api.image('stats').catch((e) => ({ ok: false, message: (e && e.message) || '调用失败' })),
      ]);
      if (pRes.ok) {
        const today = dateUtil.beijingToday();
        data.periodsAll = pRes.periods.map((p) => {
          const badge = dateUtil.periodBadge(p.startDate, p.endDate, today);
          return {
            _id: p._id,
            startDate: p.startDate,
            // 「周X打头」去掉了：列表变长的痛点就是每行信息太满，
            // 而相对标记（在吃 / 3 周前）比它更能回答「我该点哪一行」。
            rangeText: dateUtil.fmtRange(p.startDate, p.endDate),
            badgeText: badge.text,
            isCurrent: badge.isCurrent,
          };
        });
        data.periodTotal = data.periodsAll.length;
        data.periodTruncated = data.periodsAll.length >= PERIOD_LIMIT;
        data.periodsShown = this._slicePeriods(data.periodsAll, false);
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

  /** 按展开状态切出要渲染的那一段；收起时只留最近 PERIOD_PREVIEW 期 */
  _slicePeriods(all, expanded) {
    const list = all || [];
    return expanded ? list : list.slice(0, PERIOD_PREVIEW);
  },

  /** 历史周期：展开全部 / 收起。数据已在内存里，切换不产生请求 */
  togglePeriods() {
    const expanded = !this.data.periodExpanded;
    this.setData({
      periodExpanded: expanded,
      periodsShown: this._slicePeriods(this.data.periodsAll, expanded),
    });
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

  /** 配图管理：进得去，用户就不用再来问「我是不是被多扣了次数」 */
  goGallery() {
    wx.navigateTo({ url: '/pages/gallery/gallery' });
  },

  clearCache() {
    imageStore.clear();
    wx.showToast({ title: '已清除', icon: 'success' });
  },
});

// pages/day/day.js — 单日详情
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dateUtil = require('../../utils/date');
const dishNav = require('../../utils/dishNav');

Page({
  data: {
    loading: true,
    notFound: false,
    date: '',
    dateText: '',
    day: null,
    images: {},
    tiles: [],
    prepLead: [],
    prepNotes: [],
    globalPrepList: [],
    expandedUid: '',
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
      const preps = splitPreps(res.day.prepNotes || []);
      this.setData({
        loading: false,
        day: res.day,
        images,
        tiles: withUid(res.day),
        prepLead: preps.lead,
        prepNotes: preps.rest,
        globalPrepList: Object.keys(res.day.globalPrep || {}).map((k) => ({
          label: k,
          value: res.day.globalPrep[k],
        })),
        expandedUid: '',
        periodId: res.period ? res.period._id : '',
        dateText: dateUtil.fmtCN(date),
        isToday,
      });
      wx.setNavigationBarTitle({ title: isToday ? '今天吃什么' : '那天吃什么' });
    } catch (e) {
      this.setData({ loading: false, notFound: true, errMsg: e.message });
    }
  },

  /** 点色卡：先展开做法，再点进菜品详情 */
  onDishTap(e) {
    const { key, uid, title, recipe } = e.detail;
    if (!key) return;
    if (this.data.expandedUid !== uid) {
      this.setData({ expandedUid: uid });
      return;
    }
    // 做法可能上百字，拼进 url 会撞上 navigateTo 的长度上限，先放内存中转站
    dishNav.put(key, { recipe: recipe || '' });
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

/** 与今日/一周页同款：给每餐补一个稳定 uid，避免同名菜在展开态上互相牵连 */
function withUid(day) {
  if (!day) return [];
  return (day.meals || []).map((m, i) =>
    Object.assign({}, m, {
      uid: m.meal + '-' + (m.slot || i) + '-' + ((m.dishKeys && m.dishKeys[0]) || 'empty'),
    })
  );
}

/**
 * 备料按时序拆两段：早上要动手的（泡发/解冻/腌制，步骤里常写「泡半小时」）
 * 提到「先动手」单独一屏，其余留在「备料」里。
 * 抽走之后下面不再重复渲染，否则同一件事出现两次，反而让人以为漏看了。
 */
function splitPreps(raw) {
  const all = (raw || []).map((p) => ({
    label: p.label,
    stepsText: (p.steps && p.steps.length ? p.steps.join('；') : p.rawText) || '',
  }));
  return {
    lead: all.filter((p) => p.label.indexOf('早') >= 0),
    rest: all.filter((p) => p.label.indexOf('早') < 0),
  };
}

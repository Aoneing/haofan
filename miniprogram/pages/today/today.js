// pages/today/today.js — 首页：今天 / 明天 / 三态
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dateUtil = require('../../utils/date');
const dishNav = require('../../utils/dishNav');

Page({
  data: {
    loading: true,
    state: '', // in-period | before | after | error
    errMsg: '',
    heroDate: '',
    periodRange: '',
    periodId: '',
    todayDay: null,
    tiles: [], // 今天的餐次，直接喂给 dish-tile
    tomorrowDay: null,
    tomorrowTiles: [],
    prepBar: null, // { label, count } 备料汇总条
    beforeText: '',
    expandedUid: '', // 当前展开的色卡（用 uid 判重，同名菜不会互相牵连）
  },

  onShow() {
    // 自绘 tabBar 不会自动同步选中态，每次进来都要自己报一次
    if (this.getTabBar && this.getTabBar()) {
      this.getTabBar().setActive('/pages/today/today');
    }
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
        heroDate: res.serverToday ? dateUtil.fmtCN(res.serverToday) : '',
        periodRange:
          res.period ? dateUtil.fmtRange(res.period.startDate, res.period.endDate) : '',
        todayDay: null,
        tiles: [],
        tomorrowDay: null,
        tomorrowTiles: [],
        prepBar: null,
        beforeText: '',
        expandedUid: '',
      };

      if (res.state === 'in-period') {
        const keys = [];
        collectKeys(res.today, keys);
        collectKeys(res.tomorrow, keys);
        await imageStore.hydrate(keys);
        data.todayDay = res.today;
        data.tiles = withUid(res.today);
        data.tomorrowDay = res.tomorrow;
        data.tomorrowTiles = withUid(res.tomorrow);
        data.prepBar = buildPrepBar(res.today);
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

  /* ---------- 色卡交互 ---------- */

  /** 点色卡：第一次点展开做法，再点跳菜品详情（做菜时想看做法 vs 想看大图都在同一处） */
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

  /** 备料汇总条 → 单日详情页看全部备料 */
  goPrep() {
    if (this.data.todayDay) {
      wx.navigateTo({ url: '/pages/day/day?date=' + this.data.todayDay.date });
    }
  },

  /* ---------- 跳转 ---------- */
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
  goTomorrowDetail() {
    if (this.data.tomorrowDay) {
      wx.navigateTo({ url: '/pages/day/day?date=' + this.data.tomorrowDay.date });
    }
  },
  onErrorRetry() {
    this.load();
  },
});

/**
 * 给每餐补一个稳定且唯一的 uid。
 *
 * 为什么不能直接用 dishKeys[0]：同一天两道菜可能同名（「酸奶」既出现在
 * 加餐也出现在晚餐），拿它当展开态的判据会让两张卡一起被撑开。
 * 带上餐次与slot 就不会撞。注意 uid 只用于「哪张卡展开」，
 * 跳转详情仍然用原始 dishKey —— 那是配图与详情页的主键，不能换。
 */
function withUid(day) {
  if (!day) return [];
  return (day.meals || []).map((m, i) =>
    Object.assign({}, m, {
      uid: m.meal + '-' + (m.slot || i) + '-' + ((m.dishKeys && m.dishKeys[0]) || 'empty'),
    })
  );
}

function collectKeys(day, out) {
  if (!day) return;
  (day.meals || []).forEach((m) => {
    (m.dishKeys || []).forEach((k) => {
      if (k) out.push(k);
    });
  });
}

/**
 * 备料汇总条：把当天所有备料折叠成「第一条标题 + 共 N 条」。
 *
 * 为什么不全展开：备料条目多的时候（早/晚各两三条）能把整屏撑掉，
 * 而用户多数时候只想知道「今天有没有要提前处理的东西」。
 * 想看细节点它进单日详情页，那里有完整的备料清单。
 */
function buildPrepBar(day) {
  if (!day) return null;
  const notes = day.prepNotes || [];
  const labels = notes.map((p) => (p.label || '').trim()).filter(Boolean);
  const globalCount = Object.keys(day.globalPrep || {}).length;
  const total = labels.length + globalCount;
  if (!total) return null;

  // 标题优先用带时序的那条（早上要动手的活最该被看见），没有就退回第一条
  const lead =
    labels.filter((l) => l.indexOf('早') >= 0)[0] || labels[0] || '今日备料';
  return { label: lead, count: total + ' 项' };
}
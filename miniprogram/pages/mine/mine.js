// pages/mine/mine.js — 我的：数据统计、历史周期、关于
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dateUtil = require('../../utils/date');
const openStats = require('../../utils/openStats');

/**
 * 历史周期默认只露最近几期。
 * 为什么：每导入一次就多一行，攒到十几期后这一块能把「食材处理」「小工具」全顶到屏幕外，
 * 而用户真正常点的只有最近一两期。默认收起 + 一键展开，两头都照顾到。
 */
const PERIOD_PREVIEW = 3;
/** 向云函数要多少期（云函数侧上限 50，再多也只会静默截断） */
const PERIOD_LIMIT = 50;
/**
 * 配图管理卡上内嵌展示几张示例图。
 * 3 张是权衡出来的：半卡宽度下 3 张还能保持「文件卡」的大小与错落感，
 * 4 张以上每张会窄到看不清菜名，反而失去「这是配图预览」的意义。
 */
const GAL_PREVIEW = 3;

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
    currentRange: '', // 正在吃的那一期的区间，展示在标题右侧
    dishTotal: 0,
    // 卡片里内嵌展示「最近生成的 2 张配图」：让用户不进二级页也能看见 AI 到底画了什么
    recentImgs: [],
    dishImageError: '', // 「张配图」取数失败时的提示：以前静默 catch 成 0，看着像真没图
    envError: '',
    // 月历热力图：heatRows 是日历网格（按行渲染，每行 7 格 = 一周的周一..周日）
    heatRows: [],
    heatTitle: '',
    heatYear: 0,
    heatMonth: 0,
    heatTotal: 0,
    heatMinutes: 0,
    // 星期表头「一二三四五六日」放data，wxml 直接 wx:for，不用手写 7 个 text
    WEEK_LABELS: ['一', '二', '三', '四', '五', '六', '日'],
  },

  onShow() {
    if (this.getTabBar && this.getTabBar()) {
      this.getTabBar().setActive('/pages/mine/mine');
    }
    // 月历热力图数据在本地，同步取即可，不用等云函数。
    this.refreshHeat(this.data.heatYear, this.data.heatMonth);
    this.load();
  },

  /**
   * 渲染月历热力图。
   * @param {number} year 0 表示「跟随当前月」（首次渲染时 data 里是 0）
   * @param {number} month 同上
   */
  refreshHeat(year, month) {
    const now = new Date();
    const y = year || now.getFullYear();
    const m = !month && month !== 0 ? now.getMonth() : month;
    const cal = openStats.monthCalendar(now, y, m);
    this.setData({
      // ⚠️ 字段名必须与 wxml 的 wx:for 对上：wxml 遍历 heatRows（按行渲染日历）。
      // 之前这里写的是 heatCols（按列的视图），而 wxml 早已改成 heatRows，
      // 于是循环拿到 undefined，整个日期网格一片空白（用户实机截图）。
      heatRows: cal.rows,
      heatTitle: cal.title,
      heatYear: cal.year,
      heatMonth: cal.month,
      heatTotal: cal.total,
      heatMinutes: cal.minutes,
    });
  },

  /** 上个月 / 下个月。翻到未来月份没意义（数据还不存在），挡住并提示 */
  stepMonth(delta) {
    const now = new Date();
    const y = this.data.heatYear || now.getFullYear();
    const m = !this.data.heatMonth && this.data.heatMonth !== 0 ? now.getMonth() : this.data.heatMonth;
    const next = openStats.shiftMonth(y, m, delta);
    const isFuture =
      next.year > now.getFullYear() ||
      (next.year === now.getFullYear() && next.month > now.getMonth());
    if (isFuture) {
      wx.showToast({ title: '还没到那个月', icon: 'none' });
      return;
    }
    this.refreshHeat(next.year, next.month);
  },

  prevMonth() {
    this.stepMonth(-1);
  },

  nextMonth() {
    this.stepMonth(1);
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
      currentRange: '',
      dishTotal: 0,
      recentImgs: [],
    };
    try {
      const [pRes, sRes, lRes] = await Promise.all([
        api.query('listPeriods', { limit: PERIOD_LIMIT }),
        // 失败不再静默 catch 成 null：那会让「张配图」显示 0，看起来像一张图都没生成过，
        // 而真实原因可能只是 dishImage 没部署（2026-09-30 吃过的误导）。
        api.image('stats').catch((e) => ({ ok: false, message: (e && e.message) || '调用失败' })),
        // 卡片里要展示最近两张图。list 云端已按「有图在前 + 时间倒序」排好，
        // 只取前几条（limit 12）换临时链接，避免全量 200 条换链接白花流量。
        // 这条只是卡面装饰，取不到就画占位块，不弹错误提示（配图数本身仍走 stats 的报错）。
        api.image('list', { limit: 12 }).catch(() => ({ ok: false, items: [] })),
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
        // 标题右侧那一格显示「正在吃的这一期」；不在吃任何一期时留空，
        // 显示最近一期的区间会让人以为那就是在吃的
        const cur = data.periodsAll.filter((p) => p.isCurrent)[0];
        data.currentRange = cur ? cur.rangeText : '';
      } else {
        data.envError = pRes.message || '';
      }
      if (sRes && sRes.ok) {
        data.dishTotal = sRes.total;
      } else {
        data.dishImageError = '配图数取不到：' + ((sRes && sRes.message) || 'dishImage 可能未部署');
      }
      // 内嵌的两张图：只要真有图的（占位记录没 url），顺手写进缓存供其它页复用
      if (lRes && lRes.ok && lRes.items) {
        data.recentImgs = (lRes.items || [])
          .filter((it) => it && it.url)
          .slice(0, GAL_PREVIEW)
          .map((it) => {
            imageStore.set(it.key, it.url);
            return { key: it.key, url: it.url, title: it.title || '' };
          });
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

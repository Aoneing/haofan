// pages/mine/mine.js — 我的：数据统计、历史周期、关于
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dateUtil = require('../../utils/date');
const openStats = require('../../utils/openStats');

/**
 * 历史周期现在由「固定高度 + scroll-view 上下滑动」承载：
 * 全部渲染，多出的旧食谱靠滚动查看，不再做「收起只露 N 期」的截断
 * （2026-10-09 需求变更：去掉展开全部按钮）。
 */
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
    currentRange: '', // 正在吃的那一期的区间，展示在标题右侧
    dishTotal: 0,
    // 卡片里内嵌展示「最近生成的 2 张配图」：让用户不进二级页也能看见 AI 到底画了什么
    recentImgs: [],
    dishImageError: '', // 「张配图」取数失败时的提示：以前静默 catch 成 0，看着像真没图
    envError: '',
    // 月历热力图：heatRows 是日历网格（按行渲染，每行 7 格 = 一周的周一..周日）
    heatRows: [],
    heatTitle: '',
    // 用 null 表示「尚未定位到任何月份」。不能初始化成 0 ——
    // 月份 0-11 里 0 就是一月，当哨兵会让页面永远停在一月（实机踩过）。
    heatYear: null,
    heatMonth: null,
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
    // ⚠️ 必须传 null 而不是 data 里的初始值 0：
    //   月份是 0-11，0 是合法值（一月）。曾用 heatMonth=0 当「未指定」，
    //   refreshHeat 里 `!month && month !== 0` 判false ⇒ 算出 m=0
    //   ⇒ 页面永远停在一月（2026年1月），而不是当月。
    this.refreshHeat(null, null);
    // 首次进入才全量加载（带 loading）；之后切回走静默刷新，不闪空白
    if (!this._inited) {
      this._inited = true;
      this.load();
    } else {
      this.load(true);
    }
  },

  /**
   * 渲染月历热力图。
   * @param {number|null} year 传 null/null 表示「跟随当前月」
   * @param {number|null} month 同上。**不要用 0 当哨兵值**（0 是合法的一月）
   */
  refreshHeat(year, month) {
    const now = new Date();
    const y = year === null || year === undefined ? now.getFullYear() : year;
    const m = month === null || month === undefined ? now.getMonth() : month;
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
    // 同样不能用 || 当哨兵：heatMonth=0 是一月（合法值），
    // 但 heatYear 一旦为 0 会被 || 吞掉。显式判null。
    const y = this.data.heatYear || now.getFullYear();
    const m = this.data.heatMonth === null || this.data.heatMonth === undefined
      ? now.getMonth()
      : this.data.heatMonth;
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

  async load(silent) {
    // 静默刷新：已加载过就不闪 loading，直接后台拿新数据替换
    if (!silent) this.setData({ loading: true });
    const data = {
      loading: false,
      envError: '',
      dishImageError: '',
      periodsAll: [],
      periodsShown: [],
      // 静默刷新时保留「历史周期」的展开态，别切回 tab 就自动收起
      periodExpanded: silent ? this.data.periodExpanded : false,
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
            // 时间轴左列（参考 calendar UI）：起始日「日」大数字 + 月份小字
            dayNum: p.startDate ? p.startDate.slice(8, 10) : '',
            monthText: p.startDate ? parseInt(p.startDate.slice(5, 7), 10) + '月' : '',
          };
        });
        data.periodTotal = data.periodsAll.length;
        data.periodTruncated = data.periodsAll.length >= PERIOD_LIMIT;
        // 组件改为固定高度 + scroll-view 上下滑动：这里直接渲染全部，
        // 由滚动容器控制可见范围，不再做「收起只露 N 期」的截断。
        data.periodsShown = data.periodsAll;
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
      if (silent) {
        // 静默刷新失败：沿用旧数据，下次再试
        console.warn('[mine] 静默刷新失败，沿用旧数据：', e.message);
        return;
      }
      data.envError = e.message || '云函数调用失败：请确认已部署云函数并正确配置环境 ID';
    }
    this.setData(data);
  },

  /** 历史周期：全部渲染进固定高度的 scroll-view，多出的旧食谱靠上下滑动查看（无展开/收起开关） */

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

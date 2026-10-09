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
    morningPrep: null, // 早备料卡 { timing, title, items }
    eveningPrep: null, // 晚备料卡
    weeklyPrep: null, // 整周备料卡（仅周日）
    beforeText: '',
    expandedUid: '', // 当前展开的色卡（用 uid 判重，同名菜不会互相牵连）
  },

  onShow() {
    // 自绘 tabBar 不会自动同步选中态，每次进来都要自己报一次
    if (this.getTabBar && this.getTabBar()) {
      this.getTabBar().setActive('/pages/today/today');
    }
    this._alive = true;
    // 首次进入才全量加载（带 loading 骨架）；之后切回走静默刷新，
    // 直接复用内存缓存的结果，不再闪空白、不再等网络（见 utils/api 的读缓存）。
    if (!this._inited) {
      this._inited = true;
      this.load();
    } else {
      this.load(true);
    }
  },

  onHide() {
    // 离开页面就停掉轮询，避免对隐藏页 setData 与无谓的云函数调用
    this._alive = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._pollRunning = false;
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load(silent) {
    // 静默刷新：已加载过就不闪 loading，直接后台拿新数据替换，用户无感
    if (!silent) this.setData({ loading: true });
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
        morningPrep: null,
        eveningPrep: null,
        weeklyPrep: null,
        beforeText: '',
        // 静默刷新时保留当前展开的那张色卡，别一切回就收起
        expandedUid: silent ? this.data.expandedUid : '',
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
        Object.assign(data, buildPrepCards(res.today));
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
      // 今天/明天所有菜：没有新鲜配图的，自动提交生成并轮询出图（填 panel 自适应显示）
      if (res.state === 'in-period') {
        this.ensureImages(res.today, res.tomorrow);
      }
    } catch (e) {
      if (silent) {
        // 静默刷新失败：保留旧数据不闪错误页，下次再试
        console.warn('[today] 静默刷新失败，沿用旧数据：', e.message);
        return;
      }
      this.setData({ loading: false, state: 'error', errMsg: e.message });
    }
  },

  /* ---------- 自动生成 AI 配图 ----------
   * 今天/明天每道菜若没有新鲜图，就调 dishImage.generate 提交生成；
   * 同步返回的 url 立即回填，异步任务（智谱 30~180s）则轮询 resolve(collect)
   * 直到出图。已落库的菜（dishImages 有 fileID）generate 会直接回缓存，
   * 不会重复计费；同名菜在两天里出现也只生成一次（云函数 claimSlot 去重）。 */
  ensureImages(today, tomorrow) {
    const map = {}; // 菜名 -> [{ list:'tiles'|'tomorrowTiles', index }]
    const missing = [];
    const scan = (day, list) => {
      if (!day) return;
      (day.meals || []).forEach((m, i) => {
        const key = (m.dishKeys && m.dishKeys[0]) || '';
        if (!key || imageStore.getFresh(key)) return; // 已有新鲜图跳过
        if (!map[key]) map[key] = [];
        map[key].push({ list, index: i });
        if (missing.indexOf(key) < 0) missing.push(key);
      });
    };
    scan(today, 'tiles');
    scan(tomorrow, 'tomorrowTiles');
    this._keyToTiles = map;
    this._pollCount = 0; // 新一轮自动生成，轮询次数重新计
    if (!missing.length) return;

    const pending = [];
    // 串行提交：每道菜一次调用，云函数内部已做幂等/去重，本人不会重复扣费
    missing.forEach((key) => {
      const entry = map[key][0];
      const day = entry.list === 'tiles' ? today : tomorrow;
      const m = day.meals[entry.index];
      api
        .image('generate', { key, title: m.displayTitle || '', recipe: m.recipe || '' })
        .then((res) => {
          if (res && res.ok && res.url) this.flushImage(key, res.url);
          else if (res && res.pending) pending.push(key);
          // ok:false（冷却/未配置/配额）→ 放弃自动生成，等用户手动点
        })
        .catch(() => {});
    });

    if (pending.length) {
      this._pollKeys = (this._pollKeys || []).concat(pending);
      if (!this._pollRunning) this.startPoll();
    }
  },

  /** 把某道菜的图写进 imageStore 并回填到所有显示它的色卡 */
  flushImage(key, url) {
    if (!key || !url) return;
    imageStore.set(key, url);
    const entries = (this._keyToTiles && this._keyToTiles[key]) || [];
    entries.forEach((e) => {
      const list = this.data[e.list];
      if (list && list[e.index]) {
        this.setData({ [e.list + '[' + e.index + '].imageUrl']: url });
      }
    });
  },

  startPoll() {
    this._pollRunning = true;
    this.pollTick();
  },

  /** 轮询异步任务结果：每 5s 问一次 resolve(collect)，出图即回填 */
  pollTick() {
    if (!this._alive || !this._pollRunning) {
      this._pollRunning = false;
      return;
    }
    const keys = this._pollKeys || [];
    if (!keys.length) {
      this._pollRunning = false;
      return;
    }
    api
      .image('resolve', { keys, collect: true })
      .then((res) => {
        if (!this._alive) {
          this._pollRunning = false;
          return;
        }
        const map = (res && res.map) || {};
        const remain = [];
        keys.forEach((k) => {
          if (map[k]) this.flushImage(k, map[k]);
          else remain.push(k);
        });
        this._pollKeys = remain;
        // 最多轮询 24 次（约 2 分钟），仍没出图的留待下次进页面再触发
        if (remain.length && (this._pollCount = (this._pollCount || 0) + 1) < 24) {
          this._pollTimer = setTimeout(() => this.pollTick(), 5000);
        } else {
          this._pollRunning = false;
        }
      })
      .catch(() => {
        this._pollRunning = false;
      });
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
  return (day.meals || []).map((m, i) => {
    const key = (m.dishKeys && m.dishKeys[0]) || '';
    return Object.assign({}, m, {
      uid: m.meal + '-' + (m.slot || i) + '-' + (key || 'empty'),
      // 初始图：能直接命中缓存就先给（首屏可立即渲染），
      // 没有的后面靠 ensureImages 生成并 flushImage 回填
      imageUrl: imageStore.getFresh(key),
    });
  });
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
 * 备料拆成「早 / 晚」两张卡，外加「整周备料」一张（仅当天是周日才出现）。
 *
 * 早/晚分卡：用户要看的是「早上要动手的」和「晚上要备的」两件事，
 * 折叠成一条反而得点进去才知道，首页直接各给一张卡更省一步。
 * 整周备料（食材准备/备餐）属于整周级的备注，沿用「只在周日显示」的规则，
 * 避免其余六天底部重复同一段话（那条规则是用户明确要的）。
 */
function buildPrepCards(day) {
  if (!day) return { morningPrep: null, eveningPrep: null, weeklyPrep: null };
  const notes = day.prepNotes || [];
  const morning = notes.filter((p) => p.timing === 'morning');
  const evening = notes.filter((p) => p.timing !== 'morning'); // 晚 + 未识别都算晚上备料
  const weekly = Object.keys(day.globalPrep || {}).map((k) => ({
    label: k,
    stepsText: day.globalPrep[k],
  }));
  return {
    morningPrep: morning.length
      ? { timing: 'morning', title: '早 · 备料', items: morning.map(toPrepItem) }
      : null,
    eveningPrep: evening.length
      ? { timing: 'evening', title: '晚 · 备料', items: evening.map(toPrepItem) }
      : null,
    weeklyPrep:
      day.weekday === 0 && weekly.length
        ? { timing: 'weekly', title: '整周备料', items: weekly }
        : null,
  };
}

/** 备料项 → 卡片条目：步骤用「；」拼一行，没有步骤就退回原文 */
function toPrepItem(p) {
  const stepsText =
    (p.steps && p.steps.length ? p.steps.join('；') : p.rawText || '') || '';
  return { label: p.label, stepsText };
}
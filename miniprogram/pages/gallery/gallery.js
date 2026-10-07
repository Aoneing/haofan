// pages/gallery/gallery.js — 配图管理：每一张图的「账」都摊开给人看
//
// 为什么要这个页面（2026-09-30 用户原话）：
//   「我的里显示有 12 张配图了，我应该没有生成这么多，请检测」
//
// 这个疑问光靠口头解释解不掉 —— 用户需要**自己能看见**：
// 每个菜名旁边写着「提交 N 次」，N=1 就是一张图花一次，N=2 才说明有重复提交。
// 有了它，下次再怀疑就不用回来问，点开自己数。
//
// 顺带也让「图不对版」有了出口：删掉重生成一次，比解释半天管用。

const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');

// 轮询节奏（与菜品详情页 dish.js 保持一致，避免两处策略不同让人困惑）
const POLL_INTERVAL_MS = 3000; // 前段密轮询
const POLL_INTERVAL_SLOW_MS = 10000; // 90 秒后转疏，省请求
const POLL_SLOW_AFTER_MS = 90000;
const POLL_MAX_MS = 5 * 60 * 1000; // 最多等 5 分钟（云函数侧10 分钟才判超时）

// 状态 → 展示文案与配色。用中文label而不是代号：这是给家人看的管理页，不是日志
const STATUS_TEXT = {
  ready: { label: '已就绪', cls: 'gal-badge--ok' },
  pending: { label: '生成中', cls: 'gal-badge--busy' },
  saving: { label: '入库中', cls: 'gal-badge--busy' },
  failed: { label: '失败', cls: 'gal-badge--bad' },
  expired: { label: '超时失败', cls: 'gal-badge--bad' },
  none: { label: '无图', cls: 'gal-badge--idle' },
};

Page({
  data: {
    loading: true,
    items: [],
    totalGenerations: 0, // 所有菜的提交次数合计 —— 这就是「到底花了几次」的答案
    extraGenerations: 0, // 超出「一道菜一次」的部分，>0 才是真的重复扣了
    err: '',
    busyKey: '',
    // 有多少道菜正在生成中（有taskId 但没图）。>0 时页面要自动轮询收图
    pendingCount: 0,
  },

  onShow() {
    this.load().then(() => this._autoPoll());
  },

  onHide() {
    this._stopPoll();
  },

  onUnload() {
    this._stopPoll();
  },

  onPullDownRefresh() {
    this.load().then(() => {
      this._autoPoll();
      wx.stopPullDownRefresh();
    });
  },

  /**
   * 有菜还在生成中时，自动轮询把异步结果收回来。
   *
   * ★ 为什么必须有这个（2026-10-08 用户反馈「提交了一次，一直生成中，很久没生成」）：
   *   生图 30–180 秒超过云函数单次执行上限，所以 generate 只提交任务就返回，
   *   真正的「结果回收」靠 resolve({collect:true}) 顺带问一句。
   *   但**只有菜品详情页会这么问** —— 本页面原先只是被动拉 list 看库里的 status，
   *   自己从不collect。于是：任务其实早就完成或已超时，库里状态却永远停在 pending，
   *   用户看到的就是「一直生成中」（截图里还留着 10 分钟超时的 lastError 原文）。
   *   同一份轮询逻辑必须在这个页面也跑起来，否则用户在这里看不到任何进展。
   */
  _autoPoll() {
    const hasPending = this.data.items.some((it) => it.status === 'pending' || it.status === 'saving');
    if (!hasPending) {
      this._stopPoll();
      return;
    }
    this._startPoll();
  },

  _startPoll() {
    if (this._pollTimer) return; // 已在轮
    this._pollDeadline = Date.now() + POLL_MAX_MS;
    const keys = this.data.items.filter((it) => it.status === 'pending' || it.status === 'saving').map((it) => it.key);
    if (!keys.length) return;

    const tick = () => {
      api
        .image('resolve', { keys: keys, collect: true })
        .then((res) => {
          // 收到的图写进缓存，顺便让下次进页面立刻能显示
          const map = (res && res.map) || {};
          Object.keys(map).forEach((k) => imageStore.set(k, map[k]));
          const states = (res && res.states) || {};
          const done = keys.filter((k) => states[k] === 'ready' || states[k] === 'failed' || states[k] === 'expired');
          const got = done.length > 0 || Object.keys(map).length > 0;
          // 有进展就刷新列表，让用户立刻看到图/失败原因
          if (got) this.load();
          return got;
        })
        .catch(() => false)
        .then((got) => {
          if (got) {
            // 收完了就停；若刷新后仍有 pending（还有新任务），重新起一轮
            this._stopPoll();
            const rest = this.data.items.some((it) => it.status === 'pending' || it.status === 'saving');
            if (rest) this._startPoll();
            return;
          }
          if (Date.now() >= this._pollDeadline) {
            // 超时也别静默：把状态原样留着，用户手动下拉刷新能看到云函数侧的结论
            this._stopPoll();
            wx.showToast({ title: '生成比预期慢，可下拉刷新查看', icon: 'none' });
            return;
          }
          const elapsed = POLL_MAX_MS - (this._pollDeadline - Date.now());
          this._pollTimer = setTimeout(
            tick,
            elapsed < POLL_SLOW_AFTER_MS ? POLL_INTERVAL_MS : POLL_INTERVAL_SLOW_MS
          );
        });
    };
    this._pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  },

  _stopPoll() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  },

  load() {
    this.setData({ loading: true, err: '' });
    return api
      .image('list')
      .then((res) => {
        if (!res || !res.ok) {
          this.setData({ loading: false, err: (res && res.message) || '读取配图失败' });
          return;
        }
        const items = (res.items || []).map((it) => {
          const st = STATUS_TEXT[it.status] || STATUS_TEXT.none;
          return {
            key: it.key,
            title: it.title,
            url: it.url,
            hasImage: it.hasImage,
            status: it.status,
            statusLabel: st.label,
            statusCls: st.cls,
            bytesText: it.bytes ? Math.round(it.bytes / 1024) + 'KB' : '',
            submitCount: it.submitCount || 0,
            failCount: it.failCount || 0,
            lastError: it.lastError || '',
            timeText: it.generatedAt ? fmtDate(it.generatedAt) : '',
            // >1 才说明这一道菜被重复提交过，单独标出来让人一眼看到
            resubmitted: (it.submitCount || 0) > 1,
          };
        });

        const total = items.reduce((s, i) => s + i.submitCount, 0);
        // 「正常应该是一道菜一次」，多出来的就是非必要消耗
        const extra = items.reduce((s, i) => s + Math.max(0, i.submitCount - 1), 0);
        // 有多少道还在生成中（页面据此决定要不要自动轮询收图）
        const pendingCount = items.filter((i) => i.status === 'pending' || i.status === 'saving').length;

        this.setData({
          loading: false,
          items,
          totalGenerations: total,
          extraGenerations: extra,
          pendingCount,
        });
      })
      .catch((e) => {
        this.setData({ loading: false, err: (e && e.message) || '读取配图失败' });
      });
  },

  preview(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.previewImage({ urls: [url] });
  },

  /**
   * 删掉一张配图：图明显不对版时用（绘画模型偶尔会把「XX发糕」画成别的糕点）。
   * 删的是记录 + 云存储文件，下次走到这道菜会重新生成，不会拿到缓存里的旧图。
   */
  remove(e) {
    const { key, title } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除这张配图？',
      content: '「' + title + '」的配图会被删掉，下次打开这道菜时可以重新生成。\n不会影响食谱和做法。',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ busyKey: key });
        api
          .image('remove', { key })
          .then((res) => {
            if (!res || !res.ok) {
              wx.showToast({ title: (res && res.message) || '删除失败', icon: 'none' });
              return;
            }
            wx.showToast({ title: '已删除', icon: 'success' });
            this.load();
          })
          .catch((err) => {
            wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
          })
          .then(() => this.setData({ busyKey: '' }));
      },
    });
  },

  /**
   * 失败/超时后重新生成一次。
   *
   * 为什么必须在这里给出口（2026-10-08 用户反馈「提交了一次，一直生成中」）：
   *   云函数侧 TASK_TTL_MS 到点会把 pending 推进成 failed 并写下lastError，
   *   页面据此显示「超时失败」。但那道菜从此没有任何出路——
   *   菜品页的「生成」按钮用户不一定找得到，在这里干等也等不到图。
   *   所以直接在这里重开一局：generate 幂等，pending/失败状态允许重新提交。
   */
  retry(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || this.data.busyKey) return;
    this.setData({ busyKey: key });
    wx.showLoading({ title: '重新提交…', mask: true });
    api
      .image('generate', { key })
      .then((res) => {
        wx.hideLoading();
        if (!res || !res.ok) {
          wx.showToast({ title: (res && res.message) || '提交失败', icon: 'none' });
          return;
        }
        wx.showToast({ title: '已提交，正在生成', icon: 'success' });
        // 立刻刷新（状态会变回生成中），并立刻起轮询等图
        this.load().then(() => this._autoPoll());
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' });
      })
      .then(() => this.setData({ busyKey: '' }));
  },
});

/** 毫秒 → YYYY-MM-DD HH:mm */
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

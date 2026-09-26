// pages/dish/dish.js — 单品配图详情 + AI 生成入口
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');

// 轮询节奏：生图实测 30 秒～2 分钟+（模型波动大），前 90 秒每 3 秒一次，
// 之后降到每 10 秒一次，总上限 4 分钟。就算超时，图大概率也已落库，重进页面即可看到。
const POLL_INTERVAL_MS = 3000;
const POLL_INTERVAL_SLOW_MS = 10000;
const POLL_SLOW_AFTER_MS = 90000;
const POLL_MAX_MS = 240000;

Page({
  data: {
    key: '',
    title: '',
    url: '',
    generating: false,
    genTip: '',
  },

  onLoad(options) {
    const key = decodeURIComponent(options.key || '');
    const title = decodeURIComponent(options.title || '') || key;
    this.setData({ key, title });
    this._pollTimer = null;
    this._pollDeadline = 0;
    this._applied = false; // 同一轮只允许提示一次，避免「生成返回」与「轮询命中」重复弹窗
  },

  onShow() {
    const key = this.data.key;
    if (!key) return;
    // 先用缓存里的链接立即渲染（imageStore 内部按 TTL 判断，没过期不会多发请求）
    const cached = imageStore.get(key);
    if (cached) this.setData({ url: cached });
    // 再后台刷一次：临时链接会过期，重进页面时顺手换一张新的
    imageStore.hydrate([key]).then(() => {
      if (this.data.generating) return; // 正在生成时不要抢 UI
      const fresh = imageStore.get(key);
      if (fresh && fresh !== this.data.url) this.setData({ url: fresh });
    });
  },

  onUnload() {
    // 页面销毁必须停表，否则定时器还会在后台继续发请求、调 setData
    this._stopPoll();
  },

  onHide() {
    this._stopPoll();
    if (this.data.generating) this.setData({ generating: false, genTip: '' });
  },

  preview() {
    if (this.data.url) {
      wx.previewImage({ urls: [this.data.url] });
    }
  },

  /**
   * AI 生成配图（异步 + 轮询）
   *
   * 为什么不能用 await：单张生图要 20–90 秒，常常超过调用方的等待上限，
   * 客户端会在超时后断开并报 -3 / errMsg timeout —— 但云函数仍在后台跑完并落库。
   * 所以「调用报错」不代表「生成失败」，不能拿它当结果。
   *
   * 正确姿势：发起后立刻给用户反馈，再按 3 秒一次轮询 resolve，
   * 图一落库就能看到，不必重进页面，也不会卡住按钮。
   */
  generate() {
    if (this.data.generating) return;
    const key = this.data.key;
    if (!key) {
      wx.showToast({ title: '缺少菜名，无法生成', icon: 'none' });
      return;
    }

    this.setData({
      generating: true,
      genTip: 'AI 生成中，通常需要 30～60 秒，可以先做别的事',
    });
    this._applied = false;

    // 发起生成，但不拿它的返回当结论：返回可能因为超时永远不来，也可能晚于轮询结果到达。
    // force：已经配过图时按钮是「换一张配图」，要真的重生成，否则云函数幂等会原样返回旧图。
    api
      .image('generate', { key, title: this.data.title, force: !!this.data.url })
      .then((res) => {
        if (res && res.ok && res.fileID) {
          // 返回里带的是 https 临时链接；万一没带，就交给下面的轮询去取
          if (res.url) this._applyImage(key, res.url, '配图已更新');
          return;
        }
        if (res && res.pending) return; // 后台还在生成，交给轮询
        if (res && res.code === 'NOT_CONFIGURED') {
          this._stop('NOT_CONFIGURED');
          wx.showModal({ title: '还没配置生图服务', content: res.message, showCancel: false });
          return;
        }
        if (res && res.code === 'COOLDOWN') {
          this._fail(res.message);
          return;
        }
        this._fail((res && res.message) || '生成失败');
      })
      .catch((e) => {
        // 最常见的情况：调用被等待上限掐断。图可能马上就落库了，继续轮询即可
        console.warn('[dish] generate call interrupted, keep polling:', e && e.message);
      });

    // 同时也检查一下是不是「调用还没发出去、图其实已经在库里」（比如上次生成好了没显示）
    this._startPoll(key);
  },

  /** 轮询图库，直到拿到图或超过 POLL_MAX_MS。resolve 返回的是 https 临时链接。 */
  _startPoll(key) {
    this._stopPoll();
    this._pollDeadline = Date.now() + POLL_MAX_MS;

    const tick = () => {
      api
        .image('resolve', { keys: [key] })
        .then((res) => {
          const url = res && res.map ? res.map[key] : '';
          if (url) {
            this._applyImage(key, url, '配图已更新');
            return true; // 已拿到图，停轮
          }
          return false;
        })
        .catch(() => false)
        .then((got) => {
          if (got || !this.data.generating) return;
          if (Date.now() >= this._pollDeadline) {
            this._stop('轮询超时');
            wx.showModal({
              title: '生成比预期慢',
              content:
                '已经等了 4 分钟还没拿到结果。不过别担心：就算这里超时，云端也常会继续跑完。\n\n最简单的确认方式：退出本页再进来——图已经好了就会直接显示；还是没有的话，再点一次生成即可。',
              showCancel: false,
            });
            return;
          }
          this._setTip();
          // 前段密轮询（3 秒），90 秒后转疏（10 秒）：生图大概率落库在 2 分钟后，省请求也不错过
          const elapsed = POLL_MAX_MS - (this._pollDeadline - Date.now());
          this._pollTimer = setTimeout(
            tick,
            elapsed < POLL_SLOW_AFTER_MS ? POLL_INTERVAL_MS : POLL_INTERVAL_SLOW_MS
          );
        });
    };

    tick();
  },

  /** 按已等待时长刷新提示文案，让用户知道没卡死 */
  _setTip() {
    if (!this.data.generating) return;
    const sec = Math.round((POLL_MAX_MS - (this._pollDeadline - Date.now())) / 1000);
    const tip =
      sec < 45
        ? 'AI 生成中，通常需要 30～120 秒，可以先做别的事'
        : '还在生成中，已等待 ' + sec + ' 秒…（中途退出也没关系，重进本页就能看到）';
    if (tip !== this.data.genTip) this.setData({ genTip: tip });
  },

  _applyImage(key, url, msg) {
    if (this._applied) return;
    this._applied = true;
    imageStore.set(key, url); // 写内存缓存，回列表/周视图立刻能复用
    this._stop('got image');
    this.setData({ url });
    wx.showToast({ title: msg, icon: 'success' });
  },

  _fail(message) {
    this._stop('fail');
    wx.showToast({ title: message, icon: 'none' });
  },

  _stop(why) {
    this._stopPoll();
    if (this.data.generating) {
      console.log('[dish] poll stopped:', why);
      this.setData({ generating: false, genTip: '' });
    }
  },

  _stopPoll() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  },
});

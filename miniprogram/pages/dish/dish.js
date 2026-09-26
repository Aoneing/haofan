// pages/dish/dish.js — 单品配图详情 + AI 生成入口
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');

// 轮询间隔与总时长上限。生图实测 20–90 秒，取 120 秒留足余量。
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 120000;

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
    // 先看缓存，缓存没有再查一次库
    const cached = imageStore.get(this.data.key);
    if (cached) {
      this.setData({ url: cached });
    } else if (this.data.key) {
      imageStore.hydrate([this.data.key]).then(() => {
        this.setData({ url: imageStore.get(this.data.key) });
      });
    }
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

    // 发起生成，但不拿它的返回当结论：返回可能因为超时永远不来，也可能晚于轮询结果到达
    api
      .image('generate', { key, title: this.data.title })
      .then((res) => {
        if (res && res.ok && res.fileID) {
          this._applyImage(key, res.fileID, '配图已更新');
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

  /** 轮询图库，直到拿到 fileID 或超过 POLL_MAX_MS */
  _startPoll(key) {
    this._stopPoll();
    this._pollDeadline = Date.now() + POLL_MAX_MS;

    const tick = () => {
      api
        .image('resolve', { keys: [key] })
        .then((res) => {
          const fileID = res && res.map ? res.map[key] : '';
          if (fileID) {
            this._applyImage(key, fileID, '配图已更新');
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
              title: '还在生成中',
              content:
                'AI 生图这次超过 2 分钟了，可能还在排队，也可能是模型超时失败了。\n\n建议：稍等一会儿重进这个页面，图可能已经好了；还是没有的话，说明本次生成失败，请再点一次。',
              showCancel: false,
            });
            return;
          }
          this._setTip();
          this._pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
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
        ? 'AI 生成中，通常需要 30～60 秒，可以先做别的事'
        : '还在生成中，已等待 ' + sec + ' 秒…（超过 2 分钟可能本次失败）';
    if (tip !== this.data.genTip) this.setData({ genTip: tip });
  },

  _applyImage(key, fileID, msg) {
    if (this._applied) return;
    this._applied = true;
    imageStore.set(key, fileID); // 写内存缓存，回列表/周视图立刻能复用
    this._stop('got image');
    this.setData({ url: fileID });
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

// pages/dish/dish.js — 单品配图详情 + AI 生成入口
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');

Page({
  data: {
    key: '',
    title: '',
    url: '',
    generating: false,
  },

  onLoad(options) {
    const key = decodeURIComponent(options.key || '');
    const title = decodeURIComponent(options.title || '') || key;
    this.setData({ key, title });
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

  preview() {
    if (this.data.url) {
      wx.previewImage({ urls: [this.data.url] });
    }
  },

  async generate() {
    if (this.data.generating) return;
    const key = this.data.key;
    if (!key) {
      wx.showToast({ title: '缺少菜名，无法生成', icon: 'none' });
      return;
    }
    this.setData({ generating: true });
    try {
      const res = await api.image('generate', { key, title: this.data.title });
      if (res.ok) {
        imageStore.set(key, res.fileID);
        this.setData({ url: res.fileID });
        wx.showToast({ title: '配图已更新', icon: 'success' });
      } else if (res.code === 'NOT_CONFIGURED') {
        wx.showModal({
          title: '还没配置生图服务',
          content: res.message,
          showCancel: false,
        });
      } else {
        wx.showToast({ title: res.message || '生成失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: e.message || '生成失败', icon: 'none' });
    } finally {
      this.setData({ generating: false });
    }
  },
});

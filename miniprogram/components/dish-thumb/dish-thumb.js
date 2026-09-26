// components/dish-thumb/dish-thumb.js
const imageStore = require('../../utils/imageStore');

Component({
  properties: {
    title: { type: String, value: '' },
    url: { type: String, value: '' }, // https 临时链接（由云函数换取，不能用 cloud://）
    imgkey: { type: String, value: '' }, // 归一化菜名，仅在「链接失效自愈」时需要
    size: { type: Number, value: 96 }, // rpx
  },

  data: {
    phChar: '食',
    src: '', // 实际渲染用的链接；自愈后会覆盖掉传入的 url
  },

  observers: {
    title(v) {
      const t = String(v || '').trim();
      this.setData({ phChar: t ? t.charAt(0) : '食' });
    },
    url(v) {
      // 外部给了新链接：重置自愈标记，并覆盖上一次的自愈结果
      this._retried = false;
      this.setData({ src: v || '' });
    },
  },

  lifetimes: {
    attached() {
      if (!this.data.src && this.data.url) this.setData({ src: this.data.url });
    },
  },

  methods: {
    /**
     * 图片加载失败 → 自愈一次。
     *
     * 触发场景主要是临时链接过期（约 2 小时），或换来的链接被 CDN 拒。
     * 只重试一次：既能把过期链接换掉，又不会在真失败时打成请求风暴。
     */
    onImgError() {
      const key = this.data.imgkey;
      if (this._retried || !key) return;
      this._retried = true;
      imageStore.reload([key]).then(() => {
        const fresh = imageStore.get(key);
        if (fresh && fresh !== this.data.src) this.setData({ src: fresh });
      });
    },
  },
});

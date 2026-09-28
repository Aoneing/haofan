// components/dish-thumb/dish-thumb.js
const imageStore = require('../../utils/imageStore');

// 加载失败后的自愈重试：每次换一条新临时链接再试，指数退避，最多 3 次。
// 上限存在的意义是防请求风暴；放宽到 3 次是为了让「链接过期」这种可恢复故障一定能救回来。
const MAX_RETRY = 3;
const RETRY_BASE_MS = 400;

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
      // 外部给了新链接：重置自愈计数，并覆盖上一次的自愈结果
      this._retries = 0;
      this.setData({ src: v || '' });
    },
  },

  lifetimes: {
    attached() {
      if (!this.data.src && this.data.url) this.setData({ src: this.data.url });
    },
    detached() {
      // 组件销毁要清掉退避定时器，否则会在已卸载的组件上 setData
      if (this._timer) clearTimeout(this._timer);
    },
  },

  methods: {
    /**
     * 图片加载失败 → 换一条新链接重试。
     *
     * 触发场景主要是临时链接过期（私有读默认仅 10 分钟），或链接被 CDN 拒。
     *
     * 次数上限从「1 次」放宽到 MAX_RETRY：之前只允许一次，一旦那一次没换到有效链接，
     * 这张图在本页生命周期里就再也不会自愈了（用户只能退出重进）——这是「空白且无法恢复」的成因之一。
     * 现在按指数退避重试有限次：既能扛过链接过期，又不会在真失败时打成请求风暴。
     */
    onImgError(e) {
      const key = this.data.imgkey;
      // 把失败详情打出来：「图区空白」再发生时，控制台一眼能看出是哪一类失败，
      // 不必再去经历「猜根因 → 改代码 → 重新部署 → 再看」的往返。
      console.warn(
        '[dish-thumb] 图片加载失败 key=' + key +
          ' src=' + String(this.data.src).slice(0, 120) +
          ' detail=' + JSON.stringify((e && e.detail) || {})
      );
      if (!key) return;
      this._retries = (this._retries || 0) + 1;
      if (this._retries > MAX_RETRY) return; // 重试用尽，保持空白，静默收场
      const delay = RETRY_BASE_MS * Math.pow(2, this._retries - 1); // 指数退避
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        imageStore.reload([key]).then(() => {
          const fresh = imageStore.get(key);
          // 换到的新链接必须与当前不同才重设，否则 <image> 不重新请求，等于白试
          if (fresh && fresh !== this.data.src) {
            this.setData({ src: fresh });
          } else if (this._retries < MAX_RETRY) {
            this.onImgError(); // 没换到新链接，直接进入下一次重试
          }
        });
      }, delay);
    },
  },
});

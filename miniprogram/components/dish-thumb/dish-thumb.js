// components/dish-thumb/dish-thumb.js
Component({
  properties: {
    title: { type: String, value: '' },
    url: { type: String, value: '' },
    size: { type: Number, value: 96 }, // rpx
  },

  data: {
    phChar: '食',
  },

  observers: {
    title(v) {
      const t = String(v || '').trim();
      this.setData({ phChar: t ? t.charAt(0) : '食' });
    },
  },
});

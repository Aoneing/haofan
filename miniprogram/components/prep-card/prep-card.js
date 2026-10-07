// components/prep-card/prep-card.js
// 一张备料卡：按 timing 渲染「早 · 备料 / 晚 · 备料 / 整周备料」。
// 数据由父页面算好后传进来，组件只负责「把一组备料变成一张可点的卡」。
Component({
  properties: {
    title: { type: String, value: '' }, // 卡标题，如「早 · 备料」
    timing: { type: String, value: 'morning' }, // morning | evening | weekly
    items: { type: Array, value: [] }, // [{ label, stepsText }]
  },

  data: { chip: '早' },

  observers: {
    timing(t) {
      const map = { morning: '早', evening: '晚', weekly: '周' };
      this.setData({ chip: map[t] || '备' });
    },
  },

  methods: {
    onTap() {
      this.triggerEvent('preptap');
    },
  },
});

// components/dish-tile/dish-tile.js
// 一张菜品色卡。数据全部由父组件算好后从 properties 传进来，
// 组件内部不做数据加工 —— 只负责「把 meal 变成一张好看的卡」。
const nutrition = require('../../utils/nutrition');
const { tileTone } = require('../../utils/const');

Component({
  properties: {
    meal: { type: Object, value: null }, // day.meals 里的一项
    tone: { type: Number, value: 0 }, // 四色轮转下标，由父组件算
    expanded: { type: Boolean, value: false },
  },

  data: { vm: null },

  observers: {
    'meal, tone, expanded'() {
      this.setData({ vm: this.buildVm() });
    },
  },

  methods: {
    buildVm() {
      const m = this.properties.meal;
      if (!m) return null;
      const key = (m.dishKeys && m.dishKeys[0]) || '';
      const title = m.missing ? '未安排' : m.displayTitle;
      const n = m.missing
        ? { kcal: 0, minutes: 0 }
        : nutrition.estimateDish(title, m.recipe);
      const t = tileTone(this.properties.tone);
      return {
        key,
        uid: m.uid || key,
        title,
        recipe: m.recipe || '',
        missing: !!m.missing,
        bg: t.bg,
        fg: t.fg,
        kcalText: nutrition.fmtKcal(n.kcal),
        minutesText: m.missing ? '—' : nutrition.fmtMinutes(n.minutes),
        expanded: !!this.properties.expanded,
      };
    },

    /** 点整张卡：抛出 meal 的主键与做法，由页面决定是展开还是跳详情 */
    onTap() {
      this.emitDish();
    },

    onMenu() {
      this.triggerEvent('menu');
    },

    /** 展开区里的「菜品详情 ›」 */
    onDetail() {
      this.emitDish();
    },

    emitDish() {
      const vm = this.data.vm;
      if (!vm || !vm.key) return;
      this.triggerEvent('dishtap', {
        key: vm.key,
        uid: vm.uid,
        title: vm.title,
        recipe: vm.recipe,
      });
    },
  },
});
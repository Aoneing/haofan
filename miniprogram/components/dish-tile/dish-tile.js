// components/dish-tile/dish-tile.js
// 一张菜品色卡。数据全部由父组件算好后从 properties 传进来，
// 组件内部不做数据加工 —— 只负责「把 meal 变成一张好看的卡」。
const nutrition = require('../../utils/nutrition');
const imageStore = require('../../utils/imageStore');
const { tileTone, mealLabel, isMainMeal, MEAL_STYLE } = require('../../utils/const');

Component({
  properties: {
    meal: { type: Object, value: null }, // day.meals 里的一项
    tone: { type: Number, value: 0 }, // 四色轮转下标，由父组件算
    expanded: { type: Boolean, value: false },
    // 父页面主动传进来的图（今日页自动生成后刷新用）。传了就优先用它，
    // 不传则组件自己从 imageStore 取 —— 两种模式互不干扰。
    image: { type: String, value: '' },
  },

  data: { vm: null },

  observers: {
    'meal, tone, expanded, image'() {
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
      // 主餐（午餐/晚餐）用加深底色 bgStrong 突出显示，配角保持四色轮转。
      // 同色系 bgStrong 比 bg 饱和，手机上读得出主次；这套色卡本就靠明度差分层。
      const isMain = isMainMeal(m.meal);
      // 主餐用加深底色 bgStrong，配角用四色轮转。bgStrong 比 bg 饱和，
      // 手机上读得出主次；这套色卡本就靠明度差分层。
      const t = isMain
        ? { bg: MEAL_STYLE[m.meal].bgStrong, fg: MEAL_STYLE[m.meal].fg }
        : tileTone(this.properties.tone);
      return {
        key,
        uid: m.uid || key,
        title,
        recipe: m.recipe || '',
        missing: !!m.missing,
        mealLabel: mealLabel(m.meal),
        main: isMain,
        image: m.missing ? '' : (this.properties.image || imageStore.getFresh(key)),
        bg: t.bg,
        fg: t.fg,
        kcalText: nutrition.fmtKcal(n.kcal),
        minutesText: m.missing ? '—' : nutrition.fmtMinutes(n.minutes),
        expanded: !!this.properties.expanded,
      };
    },

    /** 点整张卡：抛出 tap 事件，由页面决定展开/收起（不再直接跳详情） */
    onTap() {
      this.emitDish('card');
    },

    onMenu() {
      this.triggerEvent('menu');
    },

    /** 展开区里的「菜品详情 ›」：专用 detail 事件，由页面跳转详情 */
    onDetail() {
      this.emitDish('detail');
    },

    emitDish(source) {
      const vm = this.data.vm;
      if (!vm || !vm.key) return;
      this.triggerEvent('dishtap', {
        key: vm.key,
        uid: vm.uid,
        title: vm.title,
        recipe: vm.recipe,
        source: source,
      });
    },
  },
});
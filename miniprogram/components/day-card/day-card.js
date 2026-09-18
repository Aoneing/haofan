// components/day-card/day-card.js
const { MEAL_STYLE } = require('../../utils/const');
const dateUtil = require('../../utils/date');

const FALLBACK_STYLE = { bg: '#F3EEE5', fg: '#7A6A55' };

Component({
  properties: {
    day: { type: Object, value: null }, // days 表文档
    images: { type: Object, value: {} }, // dishKey -> fileID
    compact: { type: Boolean, value: false }, // 紧凑模式（周视图/明日预览）
    highlight: { type: String, value: '' }, // '' | 'today' | 'tomorrow'
  },

  data: {
    vm: null,
  },

  observers: {
    'day, images'(day, images) {
      if (!day) {
        this.setData({ vm: null });
        return;
      }
      const imgs = images || {};
      this.setData({
        vm: {
          date: day.date,
          dateText: dateUtil.fmtCN(day.date),
          meals: (day.meals || []).map((m) => {
            const style = MEAL_STYLE[m.meal] || FALLBACK_STYLE;
            // dishKey 是配图与详情页的主键；必须透传给 WXML，否则点菜品无法跳转
            const key = (m.dishKeys && m.dishKeys[0]) || '';
            return {
              mealText: m.mealText || style.label,
              bg: style.bg,
              fg: style.fg,
              key,
              title: m.missing ? '未安排' : m.displayTitle,
              recipe: m.recipe || '',
              optionsText: (m.options || []).join(' 或 '),
              imageUrl: (key && imgs[key]) || '',
              missing: !!m.missing,
              needsReview: !!m.needsReview,
            };
          }),
          prepNotes: (day.prepNotes || []).map((p) => ({
            label: p.label,
            timing: p.timing || 'unknown',
            timingText:
              p.timing === 'morning' ? '早' : p.timing === 'evening' ? '晚' : '注',
            stepsText: (p.steps && p.steps.length ? p.steps.join('；') : p.rawText) || '',
          })),
          globalPrepList: Object.keys(day.globalPrep || {}).map((k) => ({
            label: k,
            value: day.globalPrep[k],
          })),
        },
      });
    },
  },

  methods: {
    onTap() {
      const vm = this.data.vm;
      if (vm && vm.date) {
        this.triggerEvent('daytap', { date: vm.date });
      }
    },

    onDishTap(e) {
      const { key, title } = e.currentTarget.dataset;
      if (key) {
        this.triggerEvent('dishtap', { key, title });
      }
    },
  },
});

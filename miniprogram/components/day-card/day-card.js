// components/day-card/day-card.js
const { MEAL_STYLE } = require('../../utils/const');
const dateUtil = require('../../utils/date');

const FALLBACK_STYLE = { bg: '#F3EEE5', fg: '#7A6A55' };
// 展开态配图尺寸（rpx）：配图区先占位，图源后续阶段接入
const OPEN_THUMB_SIZE = 132;

Component({
  properties: {
    day: { type: Object, value: null }, // days 表文档
    images: { type: Object, value: {} }, // dishKey -> fileID
    compact: { type: Boolean, value: false }, // 紧凑模式（周视图/明日预览）
    highlight: { type: String, value: '' }, // '' | 'today' | 'tomorrow'
    // 可展开模式（今日页）：默认收起且不配图；点某一餐展开——文字放大 + 配图占位区淡入
    expandable: { type: Boolean, value: false },
  },

  data: {
    vm: null,
    expandedIndex: -1, // 手风琴：同时最多展开一餐
  },

  observers: {
    'day, images, expandable, compact'(day) {
      if (!day) {
        this.setData({ vm: null, expandedIndex: -1 });
        return;
      }
      // 换天则收起；仅配图 hydrate 更新时保留当前展开项
      const prevDate = this.data.vm && this.data.vm.date;
      const expandedIndex = prevDate === day.date ? this.data.expandedIndex : -1;
      this.setData({ vm: this.buildVm(expandedIndex), expandedIndex });
    },
  },

  methods: {
    // 构建视图模型；expandedIndex 决定哪一餐处于展开态
    buildVm(expandedIndex) {
      const day = this.data.day;
      if (!day) return null;
      const imgs = this.data.images || {};
      const expandable = this.data.expandable;
      const compact = this.data.compact;
      return {
        date: day.date,
        dateText: dateUtil.fmtCN(day.date),
        meals: (day.meals || []).map((m, idx) => {
          const style = MEAL_STYLE[m.meal] || FALLBACK_STYLE;
          // dishKey 是配图与详情页的主键；必须透传给 WXML，否则点菜品无法跳转
          const key = (m.dishKeys && m.dishKeys[0]) || '';
          const expanded = expandable && idx === expandedIndex;
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
            // 展开态派生：默认不配图、不显示做法；点开后配图与做法一并出现
            expanded,
            showThumb: expandable ? expanded : true,
            showBody: expandable ? expanded : !compact,
            bigTitle: expandable && expanded,
            thumbSize: expandable ? OPEN_THUMB_SIZE : compact ? 72 : 96,
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
      };
    },

    onTap() {
      const vm = this.data.vm;
      if (vm && vm.date) {
        this.triggerEvent('daytap', { date: vm.date });
      }
    },

    // 点整行：手风琴式展开/收起（仅可展开模式）
    onMealTap(e) {
      if (!this.data.expandable) return;
      const idx = Number(e.currentTarget.dataset.index);
      if (!Number.isInteger(idx) || idx < 0) return;
      const next = this.data.expandedIndex === idx ? -1 : idx;
      this.setData({ vm: this.buildVm(next), expandedIndex: next });
      // 展开会改变卡片高度，通知页面重新测量各日卡片位置（滚动联动依赖它）
      this.triggerEvent('expandchange', { index: next });
    },

    // 点菜名：可展开模式下视同点整行（展开/收起）；否则跳菜品详情
    onDishTap(e) {
      if (this.data.expandable) {
        this.onMealTap(e);
        return;
      }
      this.goDish(e);
    },

    // 展开区里的「菜品详情 ›」
    onDishDetail(e) {
      this.goDish(e);
    },

    goDish(e) {
      const { key, title } = e.currentTarget.dataset;
      if (key) {
        this.triggerEvent('dishtap', { key, title });
      }
    },
  },
});

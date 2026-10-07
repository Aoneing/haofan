// components/day-card/day-card.js
const { MEAL_STYLE, isMainMeal } = require('../../utils/const');
const dateUtil = require('../../utils/date');

const FALLBACK_STYLE = { bg: '#F3EEE5', fg: '#7A6A55' };
// 展开态配图尺寸（rpx）：配图区先占位，图源后续阶段接入
const OPEN_THUMB_SIZE = 132;

/**
 * 备料视图模型的拆分。
 *
 * 「早」这一类备料里装的是**必须先动手的活**（泡发、解冻、腌制——步骤里常写「泡半小时」），
 * 它是一天里第一件要做的事。原先夹在餐次列表底下，要滚很久才看得到，等于没提醒。
 * 所以开了 prepFirst 时把它抽到卡片第一行。
 *
 * 抽走之后底部就不再重复渲染，否则同一件事出现两次，反而让人以为漏看了。
 *
 * @param {Array} raw day.prepNotes
 * @param {boolean} prepFirst 是否启用「早活前置」
 */
function buildPreps(raw, prepFirst) {
  const all = (raw || []).map((p) => ({
    label: p.label,
    timing: p.timing || 'unknown',
    timingText: p.timing === 'morning' ? '早' : p.timing === 'evening' ? '晚' : '注',
    stepsText: (p.steps && p.steps.length ? p.steps.join('；') : p.rawText) || '',
  }));
  if (!prepFirst) return { prepLead: [], prepNotes: all };
  return {
    prepLead: all.filter((p) => p.timing === 'morning'),
    prepNotes: all.filter((p) => p.timing !== 'morning'),
  };
}

Component({
  properties: {
    day: { type: Object, value: null }, // days 表文档
    images: { type: Object, value: {} }, // dishKey -> fileID
    compact: { type: Boolean, value: false }, // 紧凑模式（周视图/明日预览）
    highlight: { type: String, value: '' }, // '' | 'today' | 'tomorrow'
    // 可展开模式（今日页）：默认收起且不配图；点某一餐展开——文字放大 + 配图占位区淡入
    expandable: { type: Boolean, value: false },
    // 突出主餐（午餐/晚餐）：单日详情页打开。早餐/加餐相应退一层，一眼就能分清主次。
    // 做成开关而不是写死：周视图/校对页走的也是同一个卡片，不能顺带改掉它们的观感。
    highlightKey: { type: Boolean, value: false },
    // 把「早上要动手的备料」提到卡片第一行。只给单日视角（今天 / 那天）开：
    // 周视图七张卡每张都插一块会太吵，校对页要保持跟 Excel 一致的行序便于核对。
    prepFirst: { type: Boolean, value: false },
  },

  data: {
    vm: null,
    expandedIndex: -1, // 手风琴：同时最多展开一餐
  },

  observers: {
    'day, images, expandable, compact, highlightKey, prepFirst'(day) {
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
      const highlightKey = this.data.highlightKey;
      const prepFirst = this.data.prepFirst;
      return {
        date: day.date,
        dateText: dateUtil.fmtCN(day.date),
        meals: (day.meals || []).map((m, idx) => {
          const style = MEAL_STYLE[m.meal] || FALLBACK_STYLE;
          // dishKey 是配图与详情页的主键；必须透传给 WXML，否则点菜品无法跳转
          const key = (m.dishKeys && m.dishKeys[0]) || '';
          const expanded = expandable && idx === expandedIndex;
          // 主餐（午餐/晚餐）：只有页面开了 highlightKey 才生效
          const isMain = isMainMeal(m.meal);
          const emphasize = highlightKey && isMain;
          // 「主角上抬 + 配角后退」两条一起做，单靠加深主餐底色是不够的：
          // 同色系浅色之间的色差肉眼几乎读不出来（第一版就是这么没效果的）
          const deemphasize = highlightKey && !isMain;
          return {
            mealText: m.mealText || style.label,
            bg: emphasize ? style.bgStrong || style.bg : style.bg,
            fg: style.fg,
            // 主餐左侧竖条取文字色，不额外引颜色；色块之间的差异常常读不出来，
            // 但一条饱和的竖条不会被眼睛漏掉
            bar: emphasize ? '10rpx solid ' + (style.fg || '#7A6A55') : 'none',
            meal: m.meal, // 主餐判定结果要落到 class 上，WXML 里不再做字符串比较
            isMain,
            emphasize,
            deemphasize,
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
        // 备料：先全量算出来，再按开关决定是否把「早上要动手的」抽到最前面
        ...buildPreps(day.prepNotes, prepFirst),
        // 整周备注只展示在周日（weekday===0）那天的卡片里，其余 6 天不重复
        globalPrepList: (day.weekday === 0
          ? Object.keys(day.globalPrep || {}).map((k) => ({ label: k, value: day.globalPrep[k] }))
          : []),
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
      const { key, title, recipe } = e.currentTarget.dataset;
      if (key) {
        // recipe 必须一起带出去：详情页要展示做法，而做法只在 day 文档里，
        // 详情页拿不到这一天的原始数据（它只有菜名这一个主键）。
        this.triggerEvent('dishtap', { key, title, recipe: recipe || '' });
      }
    },
  },
});

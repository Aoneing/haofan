'use strict';
/**
 * 食材分析工具单测。
 * 验证：分类命中、嵌套词不重复计、占比相加≈1、空数据兜底。
 * 用真实风格的菜名做 fixture（取自 parseExcel.test.js 里的样例）。
 */
const assert = require('assert');
const { analyzeWeek } = require('../miniprogram/utils/ingredientStats');

// 造一周 7 天，每天塞几道菜（date 必须 Y-M-D 且递增，否则区间文案取不到）
function day(date, titles) {
  return {
    date,
    meals: titles.map((t, i) => ({ meal: 'lunch', slot: i + 1, displayTitle: t, missing: false })),
  };
}

const week = [
  day('2026-09-28', ['大米糕', '莲藕消积米糊']),
  day('2026-09-29', ['照烧茄子鹅肝烩饭']),
  day('2026-09-30', ['洋葱猪肉炒蝴蝶面']),
  day('2026-10-01', ['酸奶 或 六物饮']),
  day('2026-10-02', ['紫薯肉松蒸糕']),
  day('2026-10-03', ['蒸蛋羹', '南瓜粥']),
  day('2026-10-04', ['乌梅三豆饮 或 酸奶']),
];

module.exports = [
  t(' 食材分析：空数据兜底（无 days）', () => {
    const r = analyzeWeek([]);
    assert.strictEqual(r.ready, false, '没数据时 ready 必须为 false');
    assert.strictEqual(r.variety, 0);
    assert.strictEqual(r.totalHits, 0);
    assert.ok(Array.isArray(r.categories) && r.categories.length === 6, '六大类骨架始终要有');
  }),

  t(' 食材分析：missing 的菜不计入', () => {
    const emptyDay = {
      date: '2026-09-28',
      meals: [{ meal: 'lunch', slot: 1, displayTitle: '', missing: true }],
    };
    const r = analyzeWeek([emptyDay, day('2026-09-28', ['大米糕'])]);
    assert.strictEqual(r.ready, true);
    assert.strictEqual(r.totalHits, 1, '空菜（missing）被跳过，只剩有效菜');
  }),

  t(' 食材分析：分类命中数正确', () => {
    const r = analyzeWeek(week);
    const byKey = {};
    r.categories.forEach((c) => (byKey[c.key] = c));
    assert.strictEqual(byKey.carb.count, 6, '碳水：大米糕/米糊/烩饭/蝴蝶面/糕/粥 = 6');
    assert.strictEqual(byKey.veg.count, 5, '蔬菜：莲藕/茄子/洋葱/紫薯/南瓜 = 5');
    assert.strictEqual(byKey.protein.count, 4, '蛋白质：鹅肝/猪肉/肉松/蒸蛋 = 4');
    assert.strictEqual(byKey.drink.count, 4, '饮品：酸奶×2/六物饮/饮 = 4');
    assert.strictEqual(r.totalHits, 19, '嵌套词未重复计：totalHits 须为 19（不是 21+）');
  }),

  t(' 食材分析：每个分类带实际食材明细 items（与 byCategory 同源）', () => {
    const r = analyzeWeek(week);
    const byKey = {};
    r.categories.forEach((c) => (byKey[c.key] = c));
    r.categories.forEach((c) => assert.ok(Array.isArray(c.items), c.key + ' 必须有 items 数组'));
    // 蛋白质实际食材须为 鹅肝/猪肉/肉松/蒸蛋
    assert.deepStrictEqual(
      byKey.protein.items.slice().sort(),
      ['猪肉', '鹅肝', '肉松', '蒸蛋'].slice().sort(),
      'protein.items 内容须正确'
    );
    // items 必须与 byCategory 同源（同一份去重食材）
    r.categories.forEach((c) =>
      assert.deepStrictEqual(
        c.items.slice().sort(),
        (r.byCategory[c.key] || []).slice().sort(),
        c.key + ' 的 items 应和 byCategory 同源'
      )
    );
  }),

  t(' 食材分析：嵌套词去重（大米糕 只计最长的那个）', () => {
    // 单道菜验证最干净：整周聚合时「蒸糕」也会独立命中「糕」属正常，
    // 但这里用孤立的一道「大米糕」，断言它只产出 1 个碳水词且是最长的那个。
    const r = analyzeWeek([day('2026-09-28', ['大米糕'])]);
    assert.deepStrictEqual(
      r.byCategory.carb.sort(),
      ['大米糕'],
      '「大米糕」不得同时计入 米糕/糕：' + JSON.stringify(r.byCategory.carb)
    );
    assert.strictEqual(r.totalHits, 1, '单道菜只应命中 1 次');
  }),

  t(' 食材分析：种类数 = 去重食材词数', () => {
    const r = analyzeWeek(week);
    // 碳水6 + 蔬菜5 + 蛋白4 + 饮品3(酸奶/六物饮/饮) = 18 种
    assert.strictEqual(r.variety, 18, '本周食材种类数');
  }),

  t(' 食材分析：占比相加≈100% 且格式为 N%', () => {
    const r = analyzeWeek(week);
    const sum = r.categories.reduce((s, c) => s + c.ratio, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, '各类 ratio 之和须为 1，实际 ' + sum);
    r.categories.forEach((c) => {
      assert.ok(/%$/.test(c.pct), c.key + ' 的 pct 必须是百分比文案，实际 ' + c.pct);
    });
    // 比例单调性检查：占比最大的类不应为 0
    const max = Math.max(...r.categories.map((c) => c.ratio));
    assert.ok(max > 0.2, '应有明显主力类别，最大占比 ' + max);
  }),

  t(' 食材分析：区间文案取首尾日期', () => {
    const r = analyzeWeek(week);
    assert.strictEqual(r.weekRange, '09-28 ~ 10-04', 'weekRange 须为 首尾 date 的 MM-DD，实际 ' + r.weekRange);
  }),

  t(' 食材分析：跨 3 周合并 = 各周独立算后汇总（前端按周喂 analyzeWeek）', () => {
    // 前端 getRecentWeeks 返回 3 个独立 weeks，逐周调 analyzeWeek 再展示。
    // 这里验证「3 周拼一起喂 analyzeWeek」与各周分别算后相加一致（variety 取并集）。
    const wA = [
      day('2026-09-28', ['大米糕', '莲藕消积米糊']),
      day('2026-09-29', ['照烧茄子鹅肝烩饭']),
      day('2026-09-30', ['洋葱猪肉炒蝴蝶面']),
    ];
    const wB = [
      day('2026-10-05', ['酸奶 或 六物饮']),
      day('2026-10-06', ['紫薯肉松蒸糕']),
      day('2026-10-07', ['蒸蛋羹', '南瓜粥']),
    ];
    const wC = [
      day('2026-10-12', ['乌梅三豆饮 或 酸奶']),
      day('2026-10-13', ['西兰花牛肉末']),
      day('2026-10-14', ['番茄龙利鱼面']),
    ];
    const aA = analyzeWeek(wA);
    const aB = analyzeWeek(wB);
    const aC = analyzeWeek(wC);
    const merged = analyzeWeek([...wA, ...wB, ...wC]);
    // 类别命中数：合并 = 各周之和（不同周菜名不重叠，无交叉去重干扰）
    const sumByKey = {};
    [aA, aB, aC].forEach((a) => a.categories.forEach((c) => (sumByKey[c.key] = (sumByKey[c.key] || 0) + c.count)));
    merged.categories.forEach((c) => {
      assert.strictEqual(c.count, sumByKey[c.key], '合并后 ' + c.key + ' 命中数须 = 各周之和');
    });
    // 种类数：合并 = 各周并集（注意跨周会有重复词，如「酸奶」在 wB/wC 都出现）
    const union = new Set();
    [aA, aB, aC].forEach((a) => Object.keys(a.byCategory).forEach((k) => a.byCategory[k].forEach((kw) => union.add(kw))));
    assert.strictEqual(merged.variety, union.size, '合并种类数须 = 各周关键词并集大小，实际 ' + merged.variety + ' / ' + union.size);
    assert.ok(merged.variety >= 9, '3 周累计种类数应明显多于单周，实际 ' + merged.variety);
  }),
];

function t(name, fn) {
  return { name, fn };
}

'use strict';

const assert = require('assert');
const {
  parseAOA,
  applyMerges,
  splitDish,
  splitSteps,
  normalizeDishKey,
  scanBounds,
} = require('../cloudfunctions/menuParse/lib/parseExcel');

// 复刻 food(1).xlsx 的真实结构（含全部陷阱），再加一层尾部噪声验证边界裁剪
function buildFixtureAOA() {
  const aoa = [
    ['9/20-9/26', '周日', '周一', '周二', '周三', '周四', '周五', '周六', null],
    [
      '早',
      '大米糕',
      '苹果山药馒头',
      '黑芝麻手指馒头',
      '紫薯肉松蒸糕核桃红枣枸杞山药小米糕点组合装：紫薯40克（熟）、面粉20克（蒸7分钟）',
      '大米糕',
      '山药蜜豆饼：熟山药50 + 鸡蛋1 + 牛奶50ml打细腻，加面粉20g',
      '葱香肉松蛋卷：鸡蛋1个，水80g，面粉40g',
    ],
    [
      null,
      '莲藕消积米糊：18g 莲藕，18g苹果',
      '莲藕润肺米糊：莲藕18g',
      '核桃露：小米12',
      '苹果绿豆饮：苹果40',
      '苹果山楂水：半个苹果',
      '红豆核桃奶昔：赤小豆30克',
      '山药苹果水',
    ],
    [
      '中',
      '照烧茄子鹅肝烩饭：鹅肝煎熟留底油，\n制作：洋葱炒香，收汁',
      '番茄牛腩烩饭：牛腩炖烂',
      null,
      '彩椒鸡肉烩饭：鸡肉炒熟',
      '洋葱猪肉炒蝴蝶面；蝴蝶面煮熟',
      '排骨焖饭：排骨焯水',
      '虾仁蒸蛋：虾仁去腥',
    ],
    ['加餐', '酸奶/六物饮', '水果/苹果山药水', '六物饮', '酸奶/雪梨水', '水果', '六物饮', '乌梅三豆饮/酸奶'],
    ['晚', '清蒸鲈鱼：鲈鱼去腥', '红烧鸡腿：鸡腿焯水', null, '炒时蔬', '肉末豆腐', '冬瓜丸子汤', '蒸南瓜'],
    [
      '食材处理（早）',
      '1. 洋葱1，茄子1\n2. 羊肚菌洗净温水泡半小时',
      '1. 西红柿1\n2. 面煮好',
      '1. 洋葱1，彩椒1',
      '1. 胡萝卜1.5，香菇1',
      '1. 洋葱1，玉米1',
      '1. 蝴蝶面煮熟',
      '1. 排骨焯水',
    ],
    ['解冻洗净备用（晚）', '米糊备好', '软饭备好', '米糊备好', '蒸糕做好', '蝴蝶面煮熟', '米饭备好', null],
    [],
    ['食材准备', '/排骨/虾', null, null, null, null, null, null],
    ['备餐', '1.香菇焯水', null, null, null, null, null, null],
    ['小贴士', '多喝水', null, null, null, null, null, null],
  ];
  // 尾部 188 行空噪声 + 一列空噪声，模拟真实文件的表维度虚高
  for (let i = 0; i < 188; i++) aoa.push([]);
  return aoa;
}

const NOW = new Date('2026-09-18T03:00:00Z').getTime(); // 周五，2026 年

function codes(result) {
  return result.warnings.map((w) => w.code);
}

module.exports = [
  {
    name: 'parseAOA：完整矩阵表解析出正确的周期与日期',
    fn() {
      const r = parseAOA(buildFixtureAOA(), { now: NOW });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.period.startDate, '2026-09-20');
      assert.strictEqual(r.period.endDate, '2026-09-26');
      assert.strictEqual(r.period.startWeekday, 0);
      assert.strictEqual(r.period.startWeekdayText, '周日');
      assert.strictEqual(r.period.rawRangeText, '9/20-9/26');
      assert.strictEqual(r.period.yearAssumed, false, '星期校验通过时年份不应标记为推断');
      assert.strictEqual(r.days.length, 7);
      assert.strictEqual(r.days[0].date, '2026-09-20');
      assert.strictEqual(r.days[6].date, '2026-09-26');
      assert.strictEqual(r.days[3].weekdayText, '周三');
    },
  },
  {
    name: 'parseAOA：边界裁剪忽略 188 行空噪声与空尾列',
    fn() {
      const r = parseAOA(buildFixtureAOA(), { now: NOW });
      assert.deepStrictEqual(r.stats.bounds, { maxRow: 12, maxCol: 8 });
      assert.strictEqual(r.days.length, 7, '日期列数 7，不受噪声列影响');
    },
  },
  {
    name: 'parseAOA：早餐两行 → slot 1/2，菜名与配方正确切分',
    fn() {
      const r = parseAOA(buildFixtureAOA(), { now: NOW });
      const day0 = r.days[0];
      const breakfast = day0.meals.filter((m) => m.meal === 'breakfast');
      assert.strictEqual(breakfast.length, 2);
      assert.strictEqual(breakfast[0].slot, 1);
      assert.strictEqual(breakfast[0].displayTitle, '大米糕');
      assert.strictEqual(breakfast[1].slot, 2);
      assert.strictEqual(breakfast[1].displayTitle, '莲藕消积米糊');
      assert.strictEqual(breakfast[1].recipe, '18g 莲藕，18g苹果');
      assert.deepStrictEqual(breakfast[1].dishKeys, ['莲藕消积米糊']);
    },
  },
  {
    name: 'parseAOA：全角冒号 / 分号 / 换行三种分隔符都能切',
    fn() {
      const r = parseAOA(buildFixtureAOA(), { now: NOW });
      const lunch0 = r.days[0].meals.find((m) => m.meal === 'lunch');
      assert.strictEqual(lunch0.displayTitle, '照烧茄子鹅肝烩饭');
      assert.ok(lunch0.recipe.indexOf('制作') >= 0, '换行后的配方应保留');

      const lunch4 = r.days[4].meals.find((m) => m.meal === 'lunch');
      assert.strictEqual(lunch4.displayTitle, '洋葱猪肉炒蝴蝶面', '全角分号也要能切');
      assert.strictEqual(lunch4.recipe, '蝴蝶面煮熟');
    },
  },
  {
    name: 'parseAOA：加餐「/」按二选一处理并产生 W007',
    fn() {
      const r = parseAOA(buildFixtureAOA(), { now: NOW });
      const snack0 = r.days[0].meals.find((m) => m.meal === 'snack');
      assert.deepStrictEqual(snack0.options, ['酸奶', '六物饮']);
      assert.strictEqual(snack0.displayTitle, '酸奶 或 六物饮');
      assert.deepStrictEqual(snack0.dishKeys, ['酸奶', '六物饮']);
      assert.ok(codes(r).indexOf('W007') >= 0);
    },
  },
  {
    name: 'parseAOA：空餐次标记 missing 并产生 W005',
    fn() {
      const r = parseAOA(buildFixtureAOA(), { now: NOW });
      const day2 = r.days[2];
      const lunch2 = day2.meals.find((m) => m.meal === 'lunch');
      const dinner2 = day2.meals.find((m) => m.meal === 'dinner');
      assert.strictEqual(lunch2.missing, true);
      assert.strictEqual(dinner2.missing, true);
      assert.ok(codes(r).indexOf('W005') >= 0);
      assert.strictEqual(r.stats.mealCells, 33, '35 格中 2 格为空');
    },
  },
  {
    name: 'parseAOA：超长菜名标记 needsReview 并产生 W006',
    fn() {
      const r = parseAOA(buildFixtureAOA(), { now: NOW });
      // 超长菜名在固件第 1 行「周三」列（B=周日 起算，索引 3），不在 day0
      const day3 = r.days[3];
      const long = day3.meals.find(
        (m) => m.meal === 'breakfast' && m.slot === 1 && m.displayTitle.indexOf('紫薯肉松蒸糕') === 0
      );
      assert.ok(long, '应能定位到周三列的超长菜名');
      assert.strictEqual(long.displayTitle, '紫薯肉松蒸糕核桃红枣枸杞山药小米糕点组合装');
      assert.strictEqual(long.recipe, '紫薯40克（熟）、面粉20克（蒸7分钟）');
      assert.strictEqual(long.needsReview, true);
      assert.ok(codes(r).indexOf('W006') >= 0);
    },
  },
  {
    name: 'parseAOA：备料备注按天落位，早/晚时序正确，周末缺失不告警',
    fn() {
      const r = parseAOA(buildFixtureAOA(), { now: NOW });
      const day0 = r.days[0];
      assert.strictEqual(
        day0.prepNotes.filter((p) => p.timing !== 'unknown').length,
        2,
        '早/晚两条备料；「小贴士」以 unknown 形态额外保留'
      );
      assert.strictEqual(day0.prepNotes[0].label, '食材处理（早）');
      assert.strictEqual(day0.prepNotes[0].timing, 'morning');
      assert.deepStrictEqual(day0.prepNotes[0].steps, ['洋葱1，茄子1', '羊肚菌洗净温水泡半小时']);
      assert.strictEqual(day0.prepNotes[1].timing, 'evening');
      assert.strictEqual(r.days[6].prepNotes.length, 1, '周六无解冻数据，只剩食材处理');
      const noisy = r.warnings.filter((w) => w.code === 'W005' && /备料/.test(w.message));
      assert.strictEqual(noisy.length, 0, '周末备料缺失是正常的，不应告警');
    },
  },
  {
    name: 'parseAOA：整周备注（食材准备/备餐）落到每一天',
    fn() {
      const r = parseAOA(buildFixtureAOA(), { now: NOW });
      r.days.forEach((d) => {
        assert.strictEqual(d.globalPrep['食材准备'], '/排骨/虾');
        assert.strictEqual(d.globalPrep['备餐'], '1.香菇焯水');
      });
      assert.strictEqual(r.stats.globalPrepRows, 2);
    },
  },
  {
    name: 'parseAOA：无法归类的行保留为备注并产生 W010',
    fn() {
      const r = parseAOA(buildFixtureAOA(), { now: NOW });
      const day0 = r.days[0];
      const tip = day0.prepNotes.find((p) => p.label === '小贴士');
      assert.ok(tip, '未识别标签的内容不应丢弃');
      assert.ok(codes(r).indexOf('W010') >= 0);
    },
  },
  {
    name: 'parseAOA：同周重复菜名产生 W009',
    fn() {
      const r = parseAOA(buildFixtureAOA(), { now: NOW });
      assert.ok(codes(r).indexOf('W009') >= 0);
    },
  },
  {
    name: 'parseAOA：星期校验通过时不产生 W002/W003',
    fn() {
      const r = parseAOA(buildFixtureAOA(), { now: NOW });
      assert.strictEqual(codes(r).indexOf('W002'), -1);
      assert.strictEqual(codes(r).indexOf('W003'), -1);
    },
  },
  {
    name: 'parseAOA：三年候选都对不上星期时回退当前年并告警 W002',
    fn() {
      // 9/20 的星期：2028 周三、2029 周四、2030 周五 —— 三年候选均非「周日」→ 回退当前年
      const r = parseAOA(buildFixtureAOA(), { now: new Date('2029-09-18T03:00:00Z').getTime() });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.period.startDate, '2029-09-20', '回退到当前年 2029');
      assert.strictEqual(r.period.endDate, '2029-09-26');
      assert.strictEqual(r.period.yearAssumed, true);
      assert.ok(codes(r).indexOf('W002') >= 0);
    },
  },
  {
    name: 'parseAOA：跨年周（12/28-1/3）结束年 +1',
    fn() {
      const aoa = [
        ['12/28-1/3', '周日', '周一', '周二', '周三', '周四', '周五', '周六'],
        ['早', '粥', '粥', '粥', '粥', '粥', '粥', '粥'],
      ];
      // 12/28 在 2025 年恰为周日（2026 年是周一），年份推断应命中 2025，结束日跨入 2026
      const r = parseAOA(aoa, { now: new Date('2026-12-25T03:00:00Z').getTime() });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.period.startDate, '2025-12-28');
      assert.strictEqual(r.period.endDate, '2026-01-03');
      assert.strictEqual(r.period.yearAssumed, false);
      assert.strictEqual(r.days[6].date, '2026-01-03');
    },
  },
  {
    name: 'parseAOA：缺表头 / 缺日期区间 / 空表 → 阻断性失败',
    fn() {
      const empty = parseAOA([], { now: NOW });
      assert.strictEqual(empty.ok, false);
      assert.strictEqual(empty.code, 'EMPTY');

      const noHeader = parseAOA([['随便', '什么'], ['早', '粥']], { now: NOW });
      assert.strictEqual(noHeader.ok, false);
      assert.strictEqual(noHeader.code, 'NO_HEADER');

      const noRange = parseAOA([['', '周日', '周一', '周二', '周三', '周四', '周五', '周六']], { now: NOW });
      assert.strictEqual(noRange.ok, false);
      assert.strictEqual(noRange.code, 'NO_RANGE');
    },
  },
  {
    name: 'applyMerges：纵向合并 A2:A3 与横向合并 B10:H10 都能填充',
    fn() {
      const aoa = [
        ['早', 'a', 'b'],
        [null, 'c', 'd'],
        ['食材准备', 'X', null],
      ];
      const info = applyMerges(aoa, [
        { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },
        { s: { r: 2, c: 1 }, e: { r: 2, c: 2 } },
      ]);
      assert.strictEqual(info.ranges, 2);
      assert.strictEqual(info.filled, 2);
      assert.strictEqual(aoa[1][0], '早', 'A3 应继承 A2 的「早」');
      assert.strictEqual(aoa[2][2], 'X', 'C10 应继承 B10 的值');
    },
  },
  {
    name: 'splitDish：无分隔符 / 半角冒号 / 开头序号 / 极端切分',
    fn() {
      const a = splitDish('大米糕');
      assert.strictEqual(a.displayTitle, '大米糕');
      assert.strictEqual(a.recipe, null);

      const b = splitDish('蒸蛋羹:鸡蛋1个');
      assert.strictEqual(b.displayTitle, '蒸蛋羹');
      assert.strictEqual(b.recipe, '鸡蛋1个');

      const c = splitDish('1. 南瓜粥：南瓜50g');
      assert.strictEqual(c.displayTitle, '南瓜粥');

      const d = splitDish('：土豆泥');
      assert.strictEqual(d.needsReview, true, '分隔符在开头属异常，应标记待校对');

      const e = splitDish('乌梅三豆饮/酸奶');
      assert.deepStrictEqual(e.options, ['乌梅三豆饮', '酸奶']);
      assert.strictEqual(e.displayTitle, '乌梅三豆饮 或 酸奶');
    },
  },
  {
    name: 'splitSteps：按行拆分并去掉序号',
    fn() {
      assert.deepStrictEqual(splitSteps('1. 洋葱1，茄子1\n2. 羊肚菌洗净\n3，牛肉腌制'), [
        '洋葱1，茄子1',
        '羊肚菌洗净',
        '牛肉腌制',
      ]);
      assert.deepStrictEqual(splitSteps('无序号的一段话'), ['无序号的一段话']);
      assert.deepStrictEqual(splitSteps(''), []);
    },
  },
  {
    name: 'normalizeDishKey：空白、序号、括号备注、尾部标点全部剔除',
    fn() {
      assert.strictEqual(normalizeDishKey('  苹果 山药 馒头  '), '苹果山药馒头');
      assert.strictEqual(normalizeDishKey('1.大米糕'), '大米糕');
      assert.strictEqual(normalizeDishKey('大米糕（熟）'), '大米糕');
      assert.strictEqual(normalizeDishKey('胡萝卜1.5，'), '胡萝卜1.5');
      assert.strictEqual(normalizeDishKey('莲藕消积米糊：'), '莲藕消积米糊');
      assert.strictEqual(normalizeDishKey(null), '');
    },
  },
  {
    name: 'scanBounds：只认非空区域',
    fn() {
      const b = scanBounds([
        [],
        [null, null, null, null],
        [null, 'x'],
        [],
        [],
      ]);
      assert.deepStrictEqual(b, { maxRow: 2, maxCol: 1 });
      assert.strictEqual(scanBounds([[], []]), null);
      assert.strictEqual(scanBounds([]), null);
    },
  },
];

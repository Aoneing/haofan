'use strict';

/**
 * 食材处理手册（我的 → 食材处理）的回归测试。
 *
 * 数据来源 docs/肉类处理.xlsx，由脚本转录为 miniprogram/utils/ingredientPrep.js。
 * 这组用例锁死三件事：
 *  1. 内容不丢：4 类食材 × 4 个步骤，每步都有序号/标题/正文
 *  2. 内容不脏：不能混入 Excel 的软换行、不能残留「1.」前缀、不能重复空格
 *  3. 页面接得住：手风琴一次只开一个，且嵌套循环显式命名了 index
 *     —— 第 3 条尤其重要：wx:for 嵌套时内层 index 会覆盖外层，是必现 bug
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const prep = require(path.join(ROOT, 'miniprogram/utils/ingredientPrep.js'));
const MINE_JS = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/mine/mine.js'), 'utf8');
const MINE_WXML = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/mine/mine.wxml'), 'utf8');
const MINE_WXSS = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/mine/mine.wxss'), 'utf8');

const cases = [];
const t = (name, fn) => cases.push({ name, fn });

/* ---------- 1. 数据完整性 ---------- */

t('食材处理：4 类食材，每类 4 个步骤（来自肉类处理.xlsx）', () => {
  assert.ok(Array.isArray(prep.groups), '缺少 groups');
  assert.strictEqual(prep.groups.length, 4, '应为 4 类食材');
  prep.groups.forEach((g) => {
    assert.ok(g.name, '每类都要有名称');
    assert.ok(Array.isArray(g.steps) && g.steps.length === 4, g.name + ' 应有 4 个步骤');
  });
});

t('食材处理：四类食材名称与表格一致', () => {
  const names = prep.groups.map((g) => g.name);
  ['鳕鱼/龙利鱼/黄鱼', '三文鱼', '牛肉/猪肉/鸡肉', '虾'].forEach((n) => {
    assert.ok(names.indexOf(n) >= 0, '缺少分类：' + n + '（实际：' + names.join(' / ') + '）');
  });
});

t('食材处理：每一步都有序号、标题、正文', () => {
  prep.groups.forEach((g) => {
    g.steps.forEach((s, i) => {
      assert.strictEqual(typeof s.no, 'number', g.name + ' 第 ' + (i + 1) + ' 步缺少序号');
      assert.ok(s.title && s.title.length <= 6, g.name + ' 第 ' + (i + 1) + ' 步标题异常：' + s.title);
      assert.ok(s.text && s.text.length > 5, g.name + ' 第 ' + (i + 1) + ' 步正文过短：' + s.text);
    });
  });
});

t('食材处理：序号连续，且步骤标题符合「去腥→腌制→煎/炒→回锅」', () => {
  prep.groups.forEach((g) => {
    assert.deepStrictEqual(
      g.steps.map((s) => s.no),
      [1, 2, 3, 4],
      g.name + ' 步骤序号应为 1..4'
    );
    assert.strictEqual(g.steps[0].title, '去腥', g.name + ' 第 1 步应为去腥');
    assert.strictEqual(g.steps[1].title, '腌制', g.name + ' 第 2 步应为腌制');
    assert.ok(['煎', '炒'].indexOf(g.steps[2].title) >= 0, g.name + ' 第 3 步应为煎或炒');
    assert.strictEqual(g.steps[3].title, '回锅', g.name + ' 第 4 步应为回锅');
  });
});

/* ---------- 2. 内容洁净度（转录最容易出错的地方） ---------- */

t('食材处理：正文不残留 Excel 软换行', () => {
  prep.groups.forEach((g) => {
    g.steps.forEach((s) => {
      assert.ok(!/[\r\n]/.test(s.text), g.name + ' 步骤含换行符：' + s.text.slice(0, 40));
      assert.ok(!/[\r\n]/.test(s.title), g.name + ' 标题含换行符');
    });
  });
});

t('食材处理：正文不残留「1.」这类步骤前缀（已被拆成 title）', () => {
  prep.groups.forEach((g) => {
    g.steps.forEach((s) => {
      assert.ok(!/^\d+\./.test(s.text), g.name + ' 正文仍带步骤前缀：' + s.text.slice(0, 30));
      assert.ok(!/^\d+\./.test(s.title), g.name + ' 标题仍带步骤前缀：' + s.title);
    });
  });
});

t('食材处理：正文没有连续空格与首尾空白', () => {
  prep.groups.forEach((g) => {
    g.steps.forEach((s) => {
      assert.ok(!/\s{2,}/.test(s.text), g.name + ' 正文有连续空格：' + s.text.slice(0, 50));
      assert.strictEqual(s.text, s.text.trim(), g.name + ' 正文有首尾空白');
    });
  });
});

t('食材处理：关键处理要点没被转录丢字（抽查）', () => {
  const flat = prep.groups.map((g) => g.name + '|' + g.steps.map((s) => s.text).join('|')).join('|');
  // 这些是表格里最有操作价值、也最容易在转录中丢掉的词
  ['柠檬汁', '玉米淀粉', '辅食油', '冷锅冷油', '回锅', '肉锤', '香油', '小火'].forEach((kw) => {
    assert.ok(flat.indexOf(kw) >= 0, '内容里缺少关键要点：' + kw);
  });
  // 时长信息不能丢
  assert.ok(/5-10min/.test(flat), '缺少腌制时长 5-10min');
  assert.ok(/2-3min/.test(flat), '缺少 2-3min 时长');
});

t('食材处理：声明了数据来源与录入日期（便于日后核对）', () => {
  assert.ok(prep.source, '应记录数据来源文件');
  assert.ok(prep.updatedAt, '应记录录入日期');
  assert.strictEqual(prep.title, '食材处理');
});

/* ---------- 3. 页面接线 ---------- */

t('我的页引入食材处理数据并挂到 data 上', () => {
  assert.ok(
    /require\(['"]\.\.\/\.\.\/utils\/ingredientPrep['"]\)/.test(MINE_JS),
    'mine.js 未引入 ingredientPrep'
  );
  assert.ok(/prep:/.test(MINE_JS), 'data 里缺少 prep');
  assert.ok(/prepOpenIndex/.test(MINE_JS), '缺少展开状态 prepOpenIndex');
});

t('我的页有食材处理板块', () => {
  assert.ok(/sec-head__title">食材处理<\/text>/.test(MINE_WXML), 'WXML 缺少「食材处理」区块标题');
  assert.ok(/wx:for="\{\{prep\.groups\}\}"/.test(MINE_WXML), '未遍历 prep.groups');
});

t('★ 手风琴：一次只展开一个（内容长，全展开会把页面撑爆）', () => {
  assert.ok(/togglePrep/.test(MINE_JS), '缺少 togglePrep');
  assert.ok(
    /prepOpenIndex:\s*this\.data\.prepOpenIndex === idx \? -1 : idx/.test(MINE_JS),
    'togglePrep 应做互斥：点已展开的收起，点新的切换（不能累加展开）'
  );
  assert.ok(
    /wx:if="\{\{prepOpenIndex === gindex\}\}"/.test(MINE_WXML),
    '步骤区应按 prepOpenIndex 条件渲染'
  );
});

t('★ 嵌套 wx:for 必须显式命名 index（否则内层覆盖外层，是必现 bug）', () => {
  assert.ok(/wx:for-index="gindex"/.test(MINE_WXML), '外层循环命名 gindex');
  assert.ok(/wx:for-index="sindex"/.test(MINE_WXML), '内层循环命名 sindex');
  assert.ok(/wx:for-item="step"/.test(MINE_WXML), '内层应命名 item 为 step');
  // 事件参数必须用各自的下标，不能两个都用 index
  assert.ok(/data-gindex="\{\{gindex\}\}"/.test(MINE_WXML), 'data-gindex 应用外层下标');
  assert.ok(/data-sindex="\{\{sindex\}\}"/.test(MINE_WXML), 'data-sindex 应用内层下标');
});

t('食材处理提供了复制能力（做菜时手上有油，常要发给家人）', () => {
  assert.ok(/copyPrepStep/.test(MINE_JS), '缺少 copyPrepStep');
  assert.ok(/setClipboardData/.test(MINE_JS), '应写入剪贴板');
  assert.ok(/bindlongpress="copyPrepStep"/.test(MINE_WXML), '应绑定长按事件');
});

t('食材处理板块有配套样式（不出现裸奔的白板）', () => {
  ['grow', 'grow__head', 'gstep', 'gstep__no', 'gstep__text', 'prow--t0'].forEach((cls) => {
    assert.ok(MINE_WXSS.indexOf('.' + cls) >= 0, 'WXSS 缺少样式类 .' + cls);
  });
});

module.exports = cases;

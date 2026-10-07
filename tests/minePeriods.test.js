'use strict';

/**
 * 我的页 ·「导入过的食谱」列表的回归测试（2026-09-30）
 *
 * 起因：导入一次多一行，攒久了这一块越来越长，把下面的「食材处理」「小工具」全顶出屏幕。
 *
 * 这组用例锁住三件事：
 *   · 默认只渲染最近几期，其余折叠（列表长度不再随时间线性增长）
 *   · 折叠**不能**影响顶部的「期食谱」总数（早期版本直接用渲染数组长度，一折叠就显示 3）
 *   · 列表里要有相对标记，让人一眼认出「现在在吃哪一期」
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MINE_JS = read('miniprogram/pages/mine/mine.js');
const MINE_WXML = read('miniprogram/pages/mine/mine.wxml');
const MINE_WXSS = read('miniprogram/pages/mine/mine.wxss');
const APP_WXSS = read('miniprogram/app.wxss');

// date.js 是纯函数模块（只依赖 const.js），可以直接 require 来真跑
const dateUtil = require(path.join(ROOT, 'miniprogram/utils/date.js'));

const cases = [];
const t = (name, fn) => cases.push({ name, fn });

/* ---------- 1. 折叠：列表长度不再随时间线性增长 ---------- */

t('★ 默认只渲染最近几期，不是全量铺开', () => {
  assert.ok(/const PERIOD_PREVIEW\s*=\s*\d+/.test(MINE_JS), '要有预览条数常量');
  const n = Number((MINE_JS.match(/const PERIOD_PREVIEW\s*=\s*(\d+)/) || [])[1]);
  assert.ok(n >= 1 && n <= 5, '预览条数应在 1–5 之间，实测值：' + n);
  assert.ok(/slice\(0,\s*PERIOD_PREVIEW\)/.test(MINE_JS), '★ 收起时要真的只切出前 N 条');
});

t('★ 总数与渲染列表必须是两个变量（折叠不能改统计）', () => {
  assert.ok(/periodsAll/.test(MINE_JS) && /periodsShown/.test(MINE_JS), '全集与子集要分开存');
  const from = MINE_JS.indexOf('const data = {');
  const seg = MINE_JS.slice(from, MINE_JS.indexOf('try {', from));
  assert.ok(/periodTotal:\s*0/.test(seg), '总数要单独维护');
  // ★ 「期食谱」色块已按需求移除；总数口径不变——「共 N 期」必须取 periodTotal（全集），
  //   收起状态只影响 periodsShown，绝不能影响总数
  assert.ok(/共 \{\{periodTotal\}\} 期/.test(MINE_WXML), '顶部总数必须取 periodTotal（全集），不能取渲染数组的 length');
  assert.ok(!/\{\{periodsShown\.length\}\}/.test(MINE_WXML), '不能用渲染数组长度当总数');
});

t('★ 有展开/收起开关，且切换不再发请求（数据已在内存）', () => {
  assert.ok(/togglePeriods\(\)/.test(MINE_JS), '要有 togglePeriods');
  const from = MINE_JS.indexOf('togglePeriods() {');
  const seg = MINE_JS.slice(from, MINE_JS.indexOf('},', from));
  assert.ok(/periodExpanded:\s*expanded/.test(seg), '要翻转展开状态');
  assert.ok(/periodsShown:/.test(seg), '要重算渲染列表');
  assert.ok(!/api\./.test(seg), '★ 切换不该发请求');
});

t('wxml：只有超过预览条数时才出现展开按钮，3 期以内不多一个按钮', () => {
  assert.ok(/periodTotal > periodPreview/.test(MINE_WXML), '按钮要有显示条件');
  assert.ok(/periodExpanded \?/.test(MINE_WXML), '展开后要能收起（文案要跟着变）');
  assert.ok(/还有/.test(MINE_WXML), '收起态要告诉用户还藏着几期');
});

t('标题右侧要显示总数：折叠起来时总数也得看得见', () => {
  assert.ok(/sec-head__count/.test(MINE_WXML), '要有总数位');
  assert.ok(/共 \{\{periodTotal\}\} 期/.test(MINE_WXML), '总数文案');
});

t('wxss：展开按钮要浅色且看得出能点（箭头 + 按压反馈）', () => {
  assert.ok(/\.more-btn\s*\{/.test(MINE_WXSS), '要有浅色展开按钮样式 .more-btn');
  assert.ok(/\.more-btn--press/.test(MINE_WXSS), '要有按压反馈类（hover-class）');
  assert.ok(/more-btn__caret/.test(MINE_WXML), '要有展开箭头提示可点');
  assert.ok(/more-btn--press" hover-stay-time/.test(MINE_WXML), 'WXML 要挂上按压反馈');
});

t('请求上限提到云函数允许的最大值（50），超出要给提示而不是静默截断', () => {
  assert.ok(/const PERIOD_LIMIT\s*=\s*50/.test(MINE_JS), '要按云函数上限取');
  assert.ok(/limit: PERIOD_LIMIT/.test(MINE_JS), '要真的传这个 limit');
  assert.ok(/periodTruncated/.test(MINE_JS) && /periodTruncated/.test(MINE_WXML), '★ 拿满上限要提示');
});

/* ---------- 2. 相对标记：一眼认出「现在在吃哪一期」 ---------- */

t('periodBadge：今天落在周期内 → 「在吃」且要高亮', () => {
  const b = dateUtil.periodBadge('2026-09-28', '2026-10-04', '2026-09-30');
  assert.strictEqual(b.isCurrent, true, '要标记为当前期');
  assert.strictEqual(b.text, '在吃');
});

t('periodBadge：周期边界上的第一天/最后一天也算当前期（差一天就会标错）', () => {
  assert.strictEqual(dateUtil.periodBadge('2026-09-30', '2026-10-06', '2026-09-30').isCurrent, true);
  assert.strictEqual(dateUtil.periodBadge('2026-09-24', '2026-09-30', '2026-09-30').isCurrent, true);
  assert.strictEqual(dateUtil.periodBadge('2026-09-24', '2026-09-29', '2026-09-30').isCurrent, false);
});

t('periodBadge：一个月内按「周」给距离感', () => {
  assert.strictEqual(dateUtil.periodBadge('2026-09-23', '2026-09-29', '2026-09-30').text, '1 周前');
  assert.strictEqual(dateUtil.periodBadge('2026-09-09', '2026-09-15', '2026-09-30').text, '3 周前');
});

t('periodBadge：超过一个月只说月份', () => {
  assert.strictEqual(dateUtil.periodBadge('2026-06-01', '2026-06-07', '2026-09-30').text, '6月');
});

t('★ periodBadge：跨年必须带年份，否则「12月」分不清是哪一年', () => {
  const b = dateUtil.periodBadge('2025-12-01', '2025-12-07', '2026-09-30');
  assert.ok(/25年/.test(b.text), '跨年要带年份，实际：' + b.text);
  assert.ok(/12月/.test(b.text), '还要有月份，实际：' + b.text);
});

t('periodBadge：未来的周期标「未开始」，缺数据不崩', () => {
  assert.strictEqual(dateUtil.periodBadge('2026-10-05', '2026-10-11', '2026-09-30').text, '未开始');
  assert.strictEqual(dateUtil.periodBadge('', '', '2026-09-30').text, '');
  assert.strictEqual(dateUtil.periodBadge(undefined, undefined, '2026-09-30').isCurrent, false);
});

t('periodBadge 已被导出、并在 mine 页真的用上了', () => {
  assert.ok(/periodBadge/.test(read('miniprogram/utils/date.js').split('module.exports')[1]),
    'date.js 要导出 periodBadge');
  assert.ok(/dateUtil\.periodBadge\(/.test(MINE_JS), 'mine 页要调用它');
  assert.ok(/isCurrent/.test(MINE_JS), '要把高亮标记带进渲染数据');
  assert.ok(/prow--on/.test(MINE_WXML), 'wxml 要用高亮类');
  assert.ok(/\.prow--on/.test(MINE_WXSS), 'wxss 要有高亮样式');
});

module.exports = cases;

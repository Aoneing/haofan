'use strict';

/**
 * 我的页 ·「导入过的食谱」列表的回归测试（2026-09-30 起）
 *
 * 需求演变：
 *   早期（2026-09-30）导入一次多一行，列表会无限变长，于是做了「默认只露最近 3 期 + 展开全部」的折叠。
 *   2026-10-09 改为：固定高度 + scroll-view 上下滑动，全部渲染，去掉展开全部按钮。
 *
 * 这组用例现在锁住三件事：
 *   · 列表直接渲染全部（periodsShown === periodsAll），由固定高度滚动容器控制可见范围
 *   · 总数仍取 periodTotal（全集），与渲染列表长度解耦
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

t('★ 列表直接渲染全部，不再做「收起只露 N 期」的截断', () => {
  assert.ok(!/const PERIOD_PREVIEW\s*=/.test(MINE_JS), '预览截断常量要删掉');
  assert.ok(!/_slicePeriods/.test(MINE_JS), '切片函数要删掉');
  // 渲染列表直接等于全集，由固定高度 scroll-view 控制可见范围
  assert.ok(/periodsShown\s*=\s*data\.periodsAll/.test(MINE_JS), 'periodsShown 要直接等于全集（不截断）');
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

t('★ 无展开/收起开关：全部渲染进滚动容器，多出的靠滚动查看', () => {
  assert.ok(!/togglePeriods/.test(MINE_JS), 'togglePeriods 开关要删掉');
  assert.ok(!/_slicePeriods/.test(MINE_JS), '切片逻辑要删掉');
  // 组件是固定高度 scroll-view（见下方断言），这里只确认没有「展开全部」入口
  assert.ok(!/more-btn/.test(MINE_WXML), 'wxml 不能有展开全部按钮');
});

t('wxml：固定高度滚动容器，不出现展开/收起按钮', () => {
  assert.ok(/<scroll-view[^>]*\bclass="tl"/.test(MINE_WXML), '要有 scroll-view 且挂 tl 类');
  assert.ok(/<scroll-view[^>]*\bscroll-y/.test(MINE_WXML), 'scroll-view 要开启纵向滚动');
  assert.ok(!/periodPreview/.test(MINE_WXML), '不能再引用已删除的预览常量');
  assert.ok(!/togglePeriods/.test(MINE_WXML), '不能绑定已删除的开关');
});

t('标题右侧要显示总数：折叠起来时总数也得看得见', () => {
  assert.ok(/sec-head__count/.test(MINE_WXML), '要有总数位');
  assert.ok(/共 \{\{periodTotal\}\} 期/.test(MINE_WXML), '总数文案');
});

t('wxss：滚动容器要固定高度（约 3 张卡），旧的展开按钮样式要删', () => {
  assert.ok(/\.tl\s*\{[^}]*height/.test(MINE_WXSS), '.tl 容器要有固定 height，才能 scroll-view 滚动');
  assert.ok(!/\.more-btn\s*\{/.test(MINE_WXSS), '旧的 .more-btn 样式要删掉');
  assert.ok(!/\.more-btn--press/.test(MINE_WXSS), '旧的按压反馈类要删掉');
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

t('★ 导入过的食谱：扁平时间轴 UI（参考 calendar UI，2026-10-09 换装）', () => {
  // 结构：左列起始日大数字 + 月份 → 中列轴点 + 垂直虚线 → 右列期卡片
  assert.ok(/tl__axis/.test(MINE_WXML) && /tl__dot/.test(MINE_WXML), '要有时间轴轴点结构');
  assert.ok(/tl__day/.test(MINE_WXML) && /tl__mon/.test(MINE_WXML), '左列要有日大数字 + 月份小字');
  assert.ok(/tl__card/.test(MINE_WXML) && /tl__range/.test(MINE_WXML), '右列要有期卡片');
  // 数据：mine.js 要产出 dayNum / monthText（从 startDate 切）
  assert.ok(/dayNum/.test(MINE_JS) && /monthText/.test(MINE_JS), 'periods map 要产出时间轴左列字段');
  // 扁平化：轴点/虚线/卡片样式要在 wxss，且不再用马卡龙色块叠压（.stack .prow 已废）
  assert.ok(/\.tl__axis::before/.test(MINE_WXSS) && /dashed/.test(MINE_WXSS), '轴线要用虚线');
  assert.ok(/\.tl__dot/.test(MINE_WXSS), '轴点样式要有');
  assert.ok(!/\.stack \.prow/.test(MINE_WXSS), '旧的叠压卡样式要删掉');
  // 旧胶囊「查看本周食谱」不再出现（时间轴卡片里只剩 badge + 区间）
  assert.ok(!/查看本周食谱/.test(MINE_WXML), '胶囊文案要去掉');
});

module.exports = cases;

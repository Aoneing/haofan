'use strict';

/**
 * UI 主题回归测试（2026-10-07 重构：按三张定稿图重塑视觉）
 *
 * 锁住重构后的「设计系统」不回退：
 *   · app.wxss 的核心配色 token（品牌紫 / 柠檬黄 / 浅紫 / 中紫 / 深墨绿 / 薄荷 / 浅灰 / 墨）
 *   · tabBar 走自绘（custom: true），三个 tab 的图标资源齐备
 *   · 三个主 tab 页各自在 onShow 里同步自绘导航选中态
 *   · 三个主 tab 页都用统一的 page-head 标题 + 品牌紫 hero 块（吉祥物）
 *   · 吉祥物 mascot 资源存在
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const APP_JSON = read('miniprogram/app.json');
const APP_WXSS = read('miniprogram/app.wxss');
const TB_JS = read('miniprogram/custom-tab-bar/index.js');
const TB_WXML = read('miniprogram/custom-tab-bar/index.wxml');
const TODAY_JS = read('miniprogram/pages/today/today.js');
const TODAY_WXML = read('miniprogram/pages/today/today.wxml');
const DT_JS = read('miniprogram/components/dish-tile/dish-tile.js');
const DT_WXML = read('miniprogram/components/dish-tile/dish-tile.wxml');
const WEEK_JS = read('miniprogram/pages/week/week.js');
const WEEK_WXML = read('miniprogram/pages/week/week.wxml');
const MINE_JS = read('miniprogram/pages/mine/mine.js');
const MINE_WXML = read('miniprogram/pages/mine/mine.wxml');

const cases = [];
const t = (name, fn) => cases.push({ name, fn });

/* ---------- 1. 配色 token（取自定稿图像素采样） ---------- */

const TOKENS = [
  ['--brand', '#3b3aae'],   // 品牌紫（hero 卡）
  ['--lime', '#e9f94e'],    // 柠檬黄（强调）
  ['--violet-1', '#a9b6f2'],// 浅紫
  ['--violet-2', '#7c8cd8'],// 中紫
  ['--forest', '#1f3a3d'],  // 深墨绿
  ['--mint', '#7fe3c4'],    // 薄荷
  ['--mist', '#f2f2f4'],    // 浅灰底
  ['--ink', '#0e0e10'],     // 主文（墨）
];

TOKENS.forEach(([name, hex]) => {
  t('app.wxss：token ' + name + ' = ' + hex, () => {
    assert.ok(new RegExp(name + ':\\s*' + hex, 'i').test(APP_WXSS), '缺 ' + name + ' 或取值不是 ' + hex);
  });
});

/* ---------- 2. 自绘 tabBar ---------- */

t('app.json：tabBar 走自绘（custom: true）', () => {
  assert.ok(/"custom":\s*true/.test(APP_JSON), 'tabBar 必须是自绘，原生 tabBar 渲不出「选中=黑块+白图标」');
  const app = JSON.parse(APP_JSON);
  assert.strictEqual(app.tabBar.list.length, 3, '应为 3 个 tab');
  const paths = app.tabBar.list.map((x) => x.pagePath);
  ['pages/today/today', 'pages/week/week', 'pages/mine/mine'].forEach((p) => {
    assert.ok(paths.indexOf(p) >= 0, '缺少 tab：' + p);
  });
});

t('自绘导航：TABS 三项和 setActive 都在', () => {
  assert.ok(/const TABS = \[/.test(TB_JS), 'custom-tab-bar 应有 TABS 定义');
  assert.ok(/setActive/.test(TB_JS), '要有 setActive 同步选中态');
  assert.ok(/tb__item--on/.test(TB_WXML), '选中项要有高亮类');
  ['/pages/today/today', '/pages/week/week', '/pages/mine/mine'].forEach((p) => {
    assert.ok(TB_JS.indexOf(p) >= 0, 'TABS 缺路径：' + p);
  });
});

t('三个主 tab 页都在 onShow 同步自绘导航选中态', () => {
  assert.ok(/setActive\('\/pages\/today\/today'\)/.test(TODAY_JS), 'today 要 setActive');
  assert.ok(/setActive\('\/pages\/week\/week'\)/.test(WEEK_JS), 'week 要 setActive');
  assert.ok(/setActive\('\/pages\/mine\/mine'\)/.test(MINE_JS), 'mine 要 setActive');
});

/* ---------- 3. 统一骨架：page-head 标题 + 品牌紫 hero ---------- */

t('今日/一周/我的 都用 page-head 标题', () => {
  assert.ok(/好饭 · 今日/.test(TODAY_WXML), 'today 缺 page-head 标题');
  assert.ok(/好饭 · 一周/.test(WEEK_WXML), 'week 缺 page-head 标题');
  assert.ok(/好饭 · 我的/.test(MINE_WXML), 'mine 缺 page-head 标题');
});

t('三个主 tab 页都有品牌紫 hero 块（吉祥物）', () => {
  [TODAY_WXML, WEEK_WXML, MINE_WXML].forEach((src, i) => {
    const name = ['today', 'week', 'mine'][i];
    assert.ok(/class="hero"/.test(src), name + ' 缺 hero 块');
    assert.ok(/hero__mascot/.test(src), name + ' 的 hero 缺吉祥物');
    assert.ok(/\/images\/mascot\.png/.test(src), name + ' 没引用 mascot 资源');
  });
});

/* ---------- 4. 菜品色卡必须标注餐次（早餐/午餐/晚餐/加餐） ---------- */

t('dish-tile：vm 带上餐次中文标签', () => {
  assert.ok(/mealLabel/.test(DT_JS), 'dish-tile.js 应调用 mealLabel 取餐次文案');
  assert.ok(/mealLabel:\s*mealLabel/.test(DT_JS), 'vm 必须含 mealLabel 字段');
});

t('dish-tile：餐次标签渲染在卡上（dt__meal 胶囊）', () => {
  assert.ok(/class="dt__meal"/.test(DT_WXML), 'wxml 要有 dt__meal 标签元素');
  assert.ok(/\{\{vm\.mealLabel\}\}/.test(DT_WXML), 'dt__meal 要绑定 vm.mealLabel');
});

t('const.mealLabel：四个餐次映射到中文', () => {
  const c = require('../miniprogram/utils/const');
  assert.strictEqual(c.mealLabel('breakfast'), '早餐');
  assert.strictEqual(c.mealLabel('lunch'), '午餐');
  assert.strictEqual(c.mealLabel('snack'), '加餐');
  assert.strictEqual(c.mealLabel('dinner'), '晚餐');
});

/* ---------- 5. 资源齐备 ---------- */

[
  'miniprogram/images/mascot.png',
  'miniprogram/images/tabbar/today.png', 'miniprogram/images/tabbar/today-on.png',
  'miniprogram/images/tabbar/week.png', 'miniprogram/images/tabbar/week-on.png',
  'miniprogram/images/tabbar/mine.png', 'miniprogram/images/tabbar/mine-on.png',
].forEach((p) => {
  t('资源存在：' + p, () => {
    assert.ok(exists(p), '缺资源：' + p + '（跑 node scripts/assets/gen-assets.js 生成）');
  });
});

module.exports = cases;

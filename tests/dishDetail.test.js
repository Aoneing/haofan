'use strict';

/**
 * 菜品详情页三项改动的回归测试：
 *   1) 详情页保留做法（day → dish 的长文本透传）
 *   2) 详情页全屏显示（满屏宽大图，高度按屏幕比例算）
 *   3) 一天里午餐/晚餐突出显示
 *
 * 这组用例针对的是「跨页面数据搬运」和「布局数值」两类最容易悄悄回归的东西：
 *   · 做法要是哪天被改回塞进 url，长做法会直接 navigateTo:fail —— 现象是点了没反应，很难查
 *   · 图高一旦写成定值，宽屏机型上会变成矮横幅，或者把做法顶出屏幕
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const dishNav = require(path.join(ROOT, 'miniprogram/utils/dishNav.js'));
const layout = require(path.join(ROOT, 'miniprogram/utils/layout.js'));
const consts = require(path.join(ROOT, 'miniprogram/utils/const.js'));

const DISH_JS = read('miniprogram/pages/dish/dish.js');
const DISH_WXML = read('miniprogram/pages/dish/dish.wxml');
const DISH_WXSS = read('miniprogram/pages/dish/dish.wxss');
const DAY_JS = read('miniprogram/pages/day/day.js');
const DAY_WXML = read('miniprogram/pages/day/day.wxml');
const TODAY_JS = read('miniprogram/pages/today/today.js');
const WEEK_JS = read('miniprogram/pages/week/week.js');
const CARD_JS = read('miniprogram/components/day-card/day-card.js');
const CARD_WXML = read('miniprogram/components/day-card/day-card.wxml');
const CARD_WXSS = read('miniprogram/components/day-card/day-card.wxss');
const THUMB_JS = read('miniprogram/components/dish-thumb/dish-thumb.js');
const THUMB_WXML = read('miniprogram/components/dish-thumb/dish-thumb.wxml');

const cases = [];
const t = (name, fn) => cases.push({ name, fn });

/* ---------- 1. 做法的中转站 ---------- */

t('dishNav：put 之后 take 能取到同样的内容', () => {
  dishNav.clear();
  dishNav.put('百香果蒸糕', { recipe: '20g 百香果汁，面粉30，红枣1个' });
  const got = dishNav.take('百香果蒸糕');
  assert.ok(got, '应取到内容');
  assert.strictEqual(got.recipe, '20g 百香果汁，面粉30，红枣1个');
});

t('dishNav：take 取到即删，同 key 不会被第二次跳转误用', () => {
  dishNav.clear();
  dishNav.put('A', { recipe: '做法A' });
  assert.strictEqual(dishNav.take('A').recipe, '做法A');
  assert.strictEqual(dishNav.take('A'), null, '取过一次就该清空');
});

t('dishNav：key 之间互不影响，未知/空 key 安全返回', () => {
  dishNav.clear();
  dishNav.put('A', { recipe: '做法A' });
  dishNav.put('B', { recipe: '做法B' });
  assert.strictEqual(dishNav.take('A').recipe, '做法A');
  assert.strictEqual(dishNav.take('B').recipe, '做法B');
  assert.strictEqual(dishNav.take('不存在'), null);
  assert.strictEqual(dishNav.take(''), null);
  assert.strictEqual(dishNav.take(undefined), null);
  dishNav.clear();
});

/* ---------- 2. 全屏大图的高度 ---------- */

t('布局：宽度恒为满屏 750rpx（dish 页 heroW）', () => {
  assert.ok(/heroW:\s*750/.test(DISH_JS), 'dish.js 里 heroW 应为 750');
  assert.ok(/size="\{\{heroW\}\}"/.test(DISH_WXML), 'hero 图要用满屏宽');
  assert.ok(/\.dish__hero\s*\{[^}]*width:\s*750rpx/.test(DISH_WXSS), '.dish__hero 应为 750rpx 宽');
});

t('布局：图高按屏幕比例算，占可视高 75%~86%（常见机型 390×756）', () => {
  const h = layout.calcHeroHeight(390, 756);
  const viewportRpx = (756 * 750) / 390;
  const ratio = h / viewportRpx;
  assert.ok(ratio >= 0.75 && ratio <= 0.86, '高度占比应在 75%~86%，实际 ' + ratio.toFixed(3));
  assert.strictEqual(h, 1134);
});

t('布局：小屏也不会被压成矮横幅（320×480 仍 ≥ 屏宽×0.75）', () => {
  const h = layout.calcHeroHeight(320, 480);
  const widthRpx = 750;
  assert.ok(h >= widthRpx * 0.75, '图高至少是屏宽的 0.75，实际 ' + h);
});

t('布局：拿不到窗口尺寸时退回兜底值，不能是 NaN', () => {
  [layout.calcHeroHeight(0, 0), layout.calcHeroHeight(undefined, undefined), layout.calcHeroHeight('x', 'y')].forEach(
    (v) => {
      assert.strictEqual(v, layout.HERO_FALLBACK_RPX, '异常入参应退回 ' + layout.HERO_FALLBACK_RPX);
      assert.ok(Number.isFinite(v), '不能算出 NaN/Infinity');
    }
  );
});

/* ---------- 3. 详情页接得住做法 ---------- */

t('dish.js：onLoad 从中转站取做法，并有 hasRecipe 派生', () => {
  assert.ok(/require\(['"]\.\.\/\.\.\/utils\/dishNav['"]\)/.test(DISH_JS), '应引入 dishNav');
  assert.ok(/dishNav\.take\(key\)/.test(DISH_JS), 'onLoad 里要 take(key)');
  assert.ok(/hasRecipe/.test(DISH_JS), '应有 hasRecipe，WXML 靠它决定显示做法还是空态');
  assert.ok(/recipe:/.test(DISH_JS), 'data 里要有 recipe');
});

t('dish.wxml：有做法区，空做法时给空态而不是留白', () => {
  assert.ok(/class="dish-sec__title">做法</.test(DISH_WXML), '应有「做法」小节');
  assert.ok(/class="dish-recipe"/.test(DISH_WXML), '应有做法正文');
  assert.ok(/dish-recipe--empty/.test(DISH_WXML), '没有做法时要显示空态文案');
  assert.ok(/copyRecipe/.test(DISH_WXML), '做法应可一键复制');
});

t('dish.js / wxml：做法可复制（长按或点「复制」）', () => {
  assert.ok(/copyRecipe\s*\(\s*\)/.test(DISH_JS), 'dish.js 应有 copyRecipe');
  assert.ok(/setClipboardData/.test(DISH_JS), '复制要走 setClipboardData');
  assert.ok(/bindlongpress="copyRecipe"/.test(DISH_WXML), '做法区应支持长按复制');
});

t('dish 页：图区圆角为 0，图要顶到屏幕边缘', () => {
  assert.ok(/radius="\{\{0\}\}"/.test(DISH_WXML), '全屏大图要传 radius=0');
  assert.ok(/radius:\s*\{\s*type:\s*Number/.test(THUMB_JS), 'dish-thumb 应支持 radius 属性');
  assert.ok(/border-radius:\{\{radius\}\}rpx/.test(THUMB_WXML), 'radius 要真的落到样式上');
});

t('dish-thumb：支持独立高度（满屏宽时不能是正方形）', () => {
  assert.ok(/height:\s*\{\s*type:\s*Number/.test(THUMB_JS), 'dish-thumb 应支持 height 属性');
  assert.ok(/height:\{\{height > 0 \? height : size\}\}rpx/.test(THUMB_WXML), 'height 为 0 时回退成正方形');
  assert.ok(/height="\{\{heroH\}\}"/.test(DISH_WXML), 'dish 页要把算出来的高度传给组件');
});

/* ---------- 4. 三个入口都要把做法带过去 ---------- */

t('day / today / week：跳转前把做法放进中转站，不拼进 url', () => {
  [DAY_JS, TODAY_JS, WEEK_JS].forEach((src, i) => {
    const name = ['day', 'today', 'week'][i];
    assert.ok(/require\(['"]\.\.\/\.\.\/utils\/dishNav['"]\)/.test(src), name + '.js 应引入 dishNav');
    assert.ok(/dishNav\.put\(key/.test(src), name + '.js 跳转前要 put 做法');
    const m = /\?key=' \+ encodeURIComponent\(key\)([\s\S]{0,120})/.exec(src);
    assert.ok(m, name + '.js 应有 dish 页跳转');
    assert.ok(m[1].indexOf('recipe') < 0, name + '.js 不能把做法拼进 url（有长度上限）');
  });
});

t('day-card：点菜名 / 点详情都把 recipe 带出去', () => {
  assert.ok(/recipe:\s*recipe \|\| ''/.test(CARD_JS), 'triggerEvent 要带上 recipe');
  const m = /data-recipe="\{\{item\.recipe\}\}"/g;
  const hits = CARD_WXML.match(m);
  assert.ok(hits && hits.length >= 2, '菜名与「菜品详情」两处都要带 data-recipe，实际 ' + (hits ? hits.length : 0));
});

/* ---------- 5. 午餐 / 晚餐突出 ---------- */

t('const：每个餐次都有加深底色 bgStrong（突出主餐用）', () => {
  Object.keys(consts.MEAL_STYLE).forEach((k) => {
    const s = consts.MEAL_STYLE[k];
    assert.ok(s.bg, k + ' 缺 bg');
    assert.ok(s.bgStrong, k + ' 缺 bgStrong');
    assert.notStrictEqual(s.bg, s.bgStrong, k + ' 的 bgStrong 不能和 bg 一样，否则等于没突出');
  });
});

t('★ const：主餐底色与常规底色的亮度差要看得出来（第一版就是差太小等于没做）', () => {
  // 感知亮度 0.299R + 0.587G + 0.114B。同色系浅色之间差不到 20/255 时，
  // 在手机上是看不出来的——第一版 lunch #EAF3DE→#D6EEBD 就是这个量级，被判「没突出」。
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  };
  consts.MAIN_MEALS.forEach((meal) => {
    const s = consts.MEAL_STYLE[meal];
    const d = Math.abs(lum(s.bg) - lum(s.bgStrong));
    assert.ok(d >= 20, meal + ' 的亮度差只有 ' + d.toFixed(1) + '（<20 肉眼读不出来）');
  });
});

t('const：主餐只有午餐和晚餐', () => {
  assert.strictEqual(consts.isMainMeal('lunch'), true);
  assert.strictEqual(consts.isMainMeal('dinner'), true);
  assert.strictEqual(consts.isMainMeal('breakfast'), false);
  assert.strictEqual(consts.isMainMeal('snack'), false);
  assert.strictEqual(consts.isMainMeal(''), false);
});

t('day-card：主餐判定落到 vm 上，且受 highlightKey 开关控制', () => {
  assert.ok(/const isMain = isMainMeal\(m\.meal\);/.test(CARD_JS), '要先按 meal 判出 isMain');
  assert.ok(/^\s+isMain,$/m.test(CARD_JS), 'isMain 要进 vm，WXML 才能用它决定样式');
  assert.ok(/^\s+emphasize,$/m.test(CARD_JS), 'emphasize 也要进 vm');
  assert.ok(/const emphasize = highlightKey && isMain;/.test(CARD_JS), '只有开了开关才真的突出');
  assert.ok(/bg:\s*emphasize \? style\.bgStrong/.test(CARD_JS), '突出时底色换成加深版');
  assert.ok(/highlightKey:\s*\{\s*type:\s*Boolean/.test(CARD_JS), 'highlightKey 要是 Boolean 属性');
  assert.ok(/'day, images, expandable, compact, highlightKey'/.test(CARD_JS), '开关变化要触发重建');
});

t('day-card：配角也要后退（只抬主角是不够的，对比才看得出来）', () => {
  assert.ok(/const deemphasize = highlightKey && !isMain;/.test(CARD_JS), 'vm 要有 deemphasize');
  assert.ok(/^\s+deemphasize,$/m.test(CARD_JS), 'deemphasize 要进 vm');
  assert.ok(/item\.deemphasize \? 'dc__meal--sub' : ''/.test(CARD_WXML), '配角要挂 dc__meal--sub');
  assert.ok(/\.dc--keymeal \.dc__meal--sub\s*\{[^}]*opacity/.test(CARD_WXSS), '配角要有透明度弱化');
});

t('day-card：主餐左侧竖条（最醒目的一处差异，也用来判断有没有生效）', () => {
  assert.ok(/bar:\s*emphasize \? '10rpx solid '/.test(CARD_JS), 'vm 要算出 bar');
  assert.ok(/border-left:\{\{item\.bar\}\}/.test(CARD_WXML), '竖条要落到内联样式上');
});

t('day-card.wxml：主餐挂 dc__meal--main，卡片根挂 dc--keymeal', () => {
  assert.ok(/dc__meal--main/.test(CARD_WXML), '主餐要有专属 class');
  assert.ok(/\{\{highlightKey \? 'dc--keymeal' : ''\}\}/.test(CARD_WXML), '卡片根要按开关加 dc--keymeal');
});

t('day-card.wxss：主餐样式只在 dc--keymeal 下生效（不影响周视图/校对页）', () => {
  assert.ok(/\.dc--keymeal \.dc__meal--main\s*\{/.test(CARD_WXSS), '主餐样式要挂在 dc--keymeal 之下');
  assert.ok(/box-shadow/.test(CARD_WXSS.slice(CARD_WXSS.indexOf('.dc--keymeal .dc__meal--main'))), '主餐要有立体阴影');
});

t('day.wxml：单日详情页打开主餐突出', () => {
  assert.ok(/highlight-key="\{\{true\}\}"/.test(DAY_WXML), 'day 页应打开 highlight-key');
});

module.exports = cases;

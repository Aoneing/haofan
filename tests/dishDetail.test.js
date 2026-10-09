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
const TODAY_WXML = read('miniprogram/pages/today/today.wxml');
const WEEK_WXML = read('miniprogram/pages/week/week.wxml');
const IMPORT_WXML = read('miniprogram/pages/import/import.wxml');
const TODAY_JS = read('miniprogram/pages/today/today.js');
const WEEK_JS = read('miniprogram/pages/week/week.js');
const CARD_JS = read('miniprogram/components/day-card/day-card.js');
const CARD_WXML = read('miniprogram/components/day-card/day-card.wxml');
const CARD_WXSS = read('miniprogram/components/day-card/day-card.wxss');
const THUMB_JS = read('miniprogram/components/dish-thumb/dish-thumb.js');
const THUMB_WXML = read('miniprogram/components/dish-thumb/dish-thumb.wxml');

// 配图链路（2026-09-30 排查「AI 生成图片失败」时定的护栏）
const IMAGE_FN = read('cloudfunctions/dishImage/index.js');
const MINE_JS = read('miniprogram/pages/mine/mine.js');
const MINE_WXML = read('miniprogram/pages/mine/mine.wxml');

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

t('布局：图高按屏幕比例算，占可视高 70%~78%（图少占屏，做法上提前可见）', () => {
  const h = layout.calcHeroHeight(390, 756);
  const viewportRpx = (756 * 750) / 390;
  const ratio = h / viewportRpx;
  assert.ok(ratio >= 0.66 && ratio <= 0.80, '高度占比应在 66%~80%，实际 ' + ratio.toFixed(3));
  assert.strictEqual(h, 1018);
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

t('dish 页：毛玻璃渐变过渡 + 大字菜名（不再用黑色压字条）', () => {
  // 白纱渐变把图下沿融进页面白底，文字压在变白的区域上，深字可读
  assert.ok(/class="dish__veil"/.test(DISH_WXML), 'wxml 要有白纱渐变层');
  assert.ok(/\.dish__veil\s*\{[^}]*linear-gradient\(/.test(DISH_WXSS), 'veil 要用白色渐变过渡');
  assert.ok(/rgba\(255,\s*255,\s*255,\s*0\)/.test(DISH_WXSS), '渐变要从全透明起（融图不突兀）');
  // 菜名不再藏在黑条里，改成大字重点显示
  assert.ok(!/dish__hero-bar/.test(DISH_WXML + DISH_WXSS), '黑色压字条要删干净');
  assert.ok(/class="dish__title"/.test(DISH_WXML), '菜名要独立成大字标题');
  assert.ok(/\.dish__title\s*\{[^}]*font-weight:\s*800/.test(DISH_WXSS), '菜名要加粗重点显示');
  // 毛玻璃状态胶囊浮在图上（参考图的角标样式）
  assert.ok(/class="dish__chip"/.test(DISH_WXML), '要有图上状态胶囊');
  assert.ok(/backdrop-filter:\s*blur\(/.test(DISH_WXSS), '胶囊要毛玻璃（backdrop-filter）');
  assert.ok(/rgba\(255,\s*255,\s*255,\s*0\.\d+\)/.test(DISH_WXSS), '胶囊底要半透白');
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
  assert.ok(
    /'day, images, expandable, compact, highlightKey, prepFirst'/.test(CARD_JS),
    '开关变化要触发重建'
  );
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

t('day.wxml：单日详情用 dish-tile 渲染，且首屏突出「先动手」备料', () => {
  assert.ok(/<dish-tile/.test(DAY_WXML), 'day 页应改用 dish-tile 色卡');
  assert.ok(/wx:key="uid"/.test(DAY_WXML), '色卡要用稳定 uid 当 key，避免同名菜互串展开态');
  assert.ok(/先动手/.test(DAY_WXML), 'day 单日详情页要把早备料铺在「先动手」一屏（只有详情页才铺开）');
});

t('today.wxml：今日用 dish-tile 网格渲染「今天的饭」，并与「明天」分块', () => {
  assert.ok(/今日/.test(TODAY_WXML), '今日页要有标题');
  assert.ok(/sec-head__title">今天的饭<\/text>/.test(TODAY_WXML), '要有「今天的饭」区块');
  assert.ok(/<dish-tile/.test(TODAY_WXML), '要用 dish-tile 色卡渲染');
  assert.ok(/wx:key="uid"/.test(TODAY_WXML), '色卡要用稳定 uid');
  assert.ok(/sec-head__title">明天<\/text>/.test(TODAY_WXML), '要有「明天」区块');
});

t('today.wxml：「今天的饭」与「明天」是两个独立数据集，互不串味', () => {
  // 旧版是同一张 day-card 复制两份，展开态会互相牵连；新版 today / tomorrow 各吃各的数组
  assert.ok(/wx:for="\{\{tiles\}\}"/.test(TODAY_WXML), '今天应遍历 tiles');
  assert.ok(/wx:for="\{\{tomorrowTiles\}\}"/.test(TODAY_WXML), '明天应遍历独立的 tomorrowTiles');
  assert.ok(/bind:dishtap="onTileTap"/.test(TODAY_WXML), '两块都要能点色卡进详情');
});

t('★ 今日页：今天+明天缺图的菜自动生成 AI 配图并显示', () => {
  const TODAY_JS = read('miniprogram/pages/today/today.js');
  // 1) 卡片要把图作为可刷新属性接进来（生成完成后由父页回填，组件才能即时重绘）
  assert.ok(/image="\{\{item\.imageUrl\}\}"/.test(TODAY_WXML), 'dish-tile 要接收 item.imageUrl');
  // 2) 加载后触发自动生成：扫描今天/明天，缺图就调 generate
  assert.ok(/ensureImages\(res\.today, res\.tomorrow\)/.test(TODAY_JS), 'in-period 后要自动触发 ensureImages');
  assert.ok(/image\('generate'/.test(TODAY_JS), '要对缺图菜调用 dishImage.generate');
  // 3) 异步任务（智谱 30~180s）靠轮询 resolve(collect) 出图，不是傻等
  assert.ok(/image\('resolve',\s*\{\s*keys,\s*collect:\s*true/.test(TODAY_JS), '要用 resolve(collect) 轮询收图');
  assert.ok(/flushImage\(/.test(TODAY_JS), '出图后要回填到色卡');
  // 4) 已落库的菜 generate 直接回缓存不重复计费（由云函数幂等保证，这里只确认不强制 force）
  assert.ok(/'generate',\s*\{\s*key/.test(TODAY_JS), '生成按菜名提交，依赖云端幂等去重');
});

/* ---------- 6. 早上的备料提到第一行 ---------- */

t('★ day-card：早备料被抽成 prepLead，且底部不重复渲染', () => {
  assert.ok(/function buildPreps\(raw, prepFirst\)/.test(CARD_JS), '备料拆分应有独立纯函数');
  assert.ok(
    /prepLead: all\.filter\(\(p\) => p\.timing === 'morning'\)/.test(CARD_JS),
    '早上那类要被抽出来'
  );
  assert.ok(
    /prepNotes: all\.filter\(\(p\) => p\.timing !== 'morning'\)/.test(CARD_JS),
    '抽走之后底部必须过滤掉，否则同一件事出现两次'
  );
  assert.ok(/if \(!prepFirst\) return \{ prepLead: \[\], prepNotes: all \}/.test(CARD_JS), '开关关闭时要维持原样');
  assert.ok(/prepFirst:\s*\{\s*type:\s*Boolean/.test(CARD_JS), 'prepFirst 要是 Boolean 属性');
  assert.ok(/'day, images, expandable, compact, highlightKey, prepFirst'/.test(CARD_JS), '开关变化要重建');
});

t('day-card.wxml：早活区块排在餐次列表之前', () => {
  const leadAt = CARD_WXML.indexOf('dc__lead');
  const mealAt = CARD_WXML.indexOf('wx:for="{{vm.meals}}"');
  assert.ok(leadAt > 0, '要有早活区块');
  assert.ok(mealAt > 0, '要有餐次列表');
  assert.ok(leadAt < mealAt, '早活必须在餐次之前 —— 需求是「放在今天的第一行」');
  assert.ok(/wx:if="\{\{vm\.prepLead\.length\}\}"/.test(CARD_WXML), '没早活时整块不显示');
});

t('早活区块不带标题行（用户明确要求去掉「早上先做」）', () => {
  // 左侧橙条 + 「早」字标签已经说清了这是什么，多一行标题纯占地方
  assert.ok(CARD_WXML.indexOf('早上先做') < 0, '早活区块不要再放标题文案');
  assert.ok(CARD_WXSS.indexOf('.dc__lead-hd') < 0, '标题对应的样式要清掉，别留死代码');
});

t('day-card.wxss：早活区块有独立强调样式（它是待办，不是备注）', () => {
  assert.ok(/\.dc__lead \{/.test(CARD_WXSS), '要有 .dc__lead 样式');
  const seg = CARD_WXSS.slice(CARD_WXSS.indexOf('.dc__lead {'), CARD_WXSS.indexOf('.dc__lead-item {'));
  assert.ok(/border-left/.test(seg), '要有左侧强调竖条');
});

t('今天/单日都前置备料：today 用 prep-card 拆早/晚、day 有「先动手」', () => {
  // 旧版是 day-card 开 prep-first 把早备料提到第一行；新版拆成两条等价链路：
  //   today 首页把早/晚备料各铺成一张 prep-card，点卡进 day 看完整清单；
  //   day 单日详情页直接铺「先动手」
  assert.ok(/<prep-card/.test(TODAY_WXML), 'today 首页要用 prep-card 渲染备料');
  assert.ok(/timing="morning"/.test(TODAY_WXML), 'today 要有「早 · 备料」卡');
  assert.ok(/timing="evening"/.test(TODAY_WXML), 'today 要有「晚 · 备料」卡');
  assert.ok(/bind:preptap="goPrep"/.test(TODAY_WXML), '备料卡要能点进单日详情看完整备料');
  assert.ok(/先动手/.test(DAY_WXML), 'day 单日详情页要把早备料铺在「先动手」');
});

t('★ today/week：备料按早/晚拆两张卡，整周备料只在周日（weekday===0）出现', () => {
  [TODAY_JS, WEEK_JS].forEach((src, i) => {
    const name = ['today', 'week'][i];
    assert.ok(/function buildPrepCards/.test(src), name + '.js 应有 buildPrepCards');
    assert.ok(/timing: 'morning'/.test(src), name + ' 要抽「早 · 备料」');
    assert.ok(/timing: 'evening'/.test(src), name + ' 要抽「晚 · 备料」');
    assert.ok(/weekday === 0/.test(src), name + ' 的整周备料必须只在周日出现');
    assert.ok(/toPrepItem/.test(src), name + ' 要有备料项映射函数');
  });
});

t('★ dish-tile：午餐/晚餐用加深底色 + 实心品牌紫徽标，今日/一周/单日一致突出', () => {
  const TILE_JS = read('miniprogram/components/dish-tile/dish-tile.js');
  const TILE_WXML = read('miniprogram/components/dish-tile/dish-tile.wxml');
  const TILE_WXSS = read('miniprogram/components/dish-tile/dish-tile.wxss');
  assert.ok(/isMainMeal\(m\.meal\)/.test(TILE_JS), 'dish-tile 要按 meal 判主餐');
  assert.ok(/isMainMeal/.test(TILE_JS), 'dish-tile 要引入 isMainMeal 判定主餐');
  assert.ok(/MEAL_STYLE\[m\.meal\]\.bgStrong/.test(TILE_JS), '主餐底色换成加深版 bgStrong');
  assert.ok(/dt--main/.test(TILE_WXML), '主餐卡根要挂 dt--main');
  assert.ok(/dt__meal--main/.test(TILE_WXML), '主餐要有实心徽标 class');
  assert.ok(/\.dt--main\s*\{[^}]*box-shadow/.test(TILE_WXSS), '主餐卡要有立体阴影突出');
  assert.ok(/\.dt__meal--main\s*\{[^}]*background:\s*#3b3aae/.test(TILE_WXSS), '主餐徽标用品牌紫实底');
});

t('多日列表视角不开 prep-first：周视图/校对页保持原样', () => {
  [WEEK_WXML, IMPORT_WXML].forEach((src, i) => {
    const name = ['week', 'import'][i];
    // 周视图七张卡每张都插一块太吵；校对页要保持与 Excel 一致的行序便于核对
    assert.ok(src.indexOf('prep-first') < 0, name + ' 页不要开 prep-first');
  });
});

/* ---------- 9. 配图链路：失败必须能看见原因（2026-09-30） ----------
 *
 * 背景：用户报「AI 生成图片失败」，点开诊断面板却只看到
 *       「自检无返回（云端可能还是旧版本）」+「url 长度：0」，给不出任何线索。
 * 代码里翻出的三个死角：
 *   a) selfcheck 的环境变量检查只看不判 —— IMAGE_API_URL 为空（没配）时也一路往下走，
 *      最后落到「未命中已知结论」的通用兜底，把「压根没配置」说成「未知问题」；
 *   b) 失败档案压根没查：results 只收「有 fileID」的记录，status=failed 的菜在写 results 前
 *      就被 continue 掉了 ⇒ 页面永远不会告诉你 lastError 是什么；
 *   c) 前端拿到 failed 后写死「请再点一次」——而真因（401/404/限流）就在 lastError 里，
 *      写死了用户只会重复点，重复点解决不了任何问题。
 * 这三条都是「查不到原因」的元凶，比生图本身失败更麻烦，所以固化成用例。
 */

t('★ selfcheck：环境变量没配就直接判 NOT_CONFIGURED，不许掉进通用兜底', () => {
  const seg = IMAGE_FN.slice(IMAGE_FN.indexOf("push('env'"), IMAGE_FN.indexOf('// 1.5 异步端点推导结果'));
  assert.ok(seg.length > 0, '找不到 env 检查那一段');
  assert.ok(/verdict = 'NOT_CONFIGURED'/.test(seg), 'env 缺失时要直接给 NOT_CONFIGURED');
  assert.ok(/return \{ ok: true, report \}/.test(seg), '判掉之后要立刻返回，不能继续往下走');
});

t('★ selfcheck：失败记录（status=failed）要单独捞出来，lastError 必须能展示', () => {
  assert.ok(/report\.failedDocs/.test(IMAGE_FN), '要把失败记录挂到 report 上');
  assert.ok(/status: 'failed'/.test(IMAGE_FN), '要按 status=failed 查一次');
  assert.ok(/lastError/.test(IMAGE_FN), 'lastError 是唯一能说明失败原因的字段');
});

t('★ selfcheck：有 key 但一条记录都没有时，要判「压根没写库」而不是「请把结果发我」', () => {
  assert.ok(/NO_RECORD_AT_ALL/.test(IMAGE_FN), '要能说出「数据库里没有这道菜的任何记录」');
  // 老文案让人去发空 results，等于让人做无用功。注释里引用它是说明历史，不算违规，
  // 所以只查「实际提示文案」那两处（hints.push 的字符串）。
  const pushes = IMAGE_FN.match(/hints\.push\([\s\S]{0,400}?\);/g) || [];
  const bad = pushes.filter((p) => p.indexOf('请把 steps / results 发我') >= 0);
  assert.strictEqual(
    bad.length,
    0,
    '别再在提示文案里让用户发 results —— results 只收有 fileID 的记录，这时它是空的'
  );
});

t('★ 前端：轮询到 failed 时不要再写死「请再点一次」', () => {
  assert.ok(
    DISH_JS.indexOf('这次生成失败了，请稍后再点一次') < 0,
    '写死这句会让用户反复点，而真因是接口报错 —— 真因在 lastError 里'
  );
  assert.ok(/this\._fail\('这次生成失败了'\)/.test(DISH_JS), '失败提示要中性，详情交给诊断面板');
});

t('★ 前端：失败后要自动刷新诊断面板，不能停留在「正在生成中」那句快照', () => {
  // 从 _stop 的定义处取到下一个方法为止，避免误抓到别处的 _runDiag
  const from = DISH_JS.indexOf('_stop(why) {');
  assert.ok(from > 0, '找不到 _stop 的定义');
  const seg = DISH_JS.slice(from, DISH_JS.indexOf('_stopPoll() {', from));
  assert.ok(/this\._runDiag\(\)/.test(seg), '停下来时若面板开着，要重跑一次自检');
});

t('★ 生图提示词：带上做法里的线索词（只有菜名时模型会凭空捏形态）', () => {
  assert.ok(/function buildPrompt\(title, recipe\)/.test(IMAGE_FN), 'buildPrompt 要吃 recipe');
  assert.ok(/extractRecipeKeywords/.test(IMAGE_FN), '要有线索词提取');
  // 「贝贝南瓜发糕」这类名字，模型不知道是蒸的还是烤的，必须靠做法里的「蒸/发酵」钉住
  const kwSeg = IMAGE_FN.slice(
    IMAGE_FN.indexOf('const RECIPE_HINTS'),
    IMAGE_FN.indexOf('function extractRecipeKeywords')
  );
  ['蒸', '发酵', '南瓜', '面粉'].forEach((w) => {
    assert.ok(kwSeg.indexOf("'" + w + "'") >= 0, '线索词表里该有「' + w + '」');
  });
});

t('★ 生图提示词：极简矢量几何风 + 色块平涂 + 明确禁字（匹配 UI 2.0 插画风）', () => {
  const from = IMAGE_FN.indexOf('function buildPrompt');
  const seg = IMAGE_FN.slice(from, IMAGE_FN.indexOf('const RECIPE_HINTS'));
  assert.ok(/矢量/.test(seg) && /色块平涂/.test(seg), '提示词要指定极简矢量 + 色块平涂');
  assert.ok(/无渐变/.test(seg) && /硬边/.test(seg), '要无渐变、清晰硬边（矢量几何特征）');
  // 2026-10-09：禁字整段前置（模型对开头权重高）；「海报」「8K」是排版触发词，必须剔除
  assert.ok(/绝对不能出现任何文字/.test(seg), '要强禁文字（只写「无文字」挡不住模型烧大字）');
  assert.ok(seg.indexOf('绝对不能出现任何文字') < seg.indexOf('极简矢量几何风食物插画'), '禁字要前置（开头权重高）');
  assert.ok(/不要把菜名写进画面/.test(seg), '要明确禁止把菜名写进画面（最常见的烧字形态）');
  assert.ok(!/海报/.test(seg), '不能出现「海报」——会触发模型往画面烧标题大字');
  assert.ok(!/8K/.test(seg), '不能出现「8K」——推向海报式构图');
  assert.ok(/柠檬黄绿|淡紫/.test(seg), '要点缀 UI 配色（柠檬黄绿/淡紫）');
  assert.ok(!/摄影|照片/.test(seg), '不能再要求摄影/照片风格');
});

t('★ 前端：generate 要把做法一起送上去', () => {
  const from = DISH_JS.indexOf(".image('generate'");
  assert.ok(from > 0, '找不到 generate 的调用');
  // 取到那个 .then( 之前为止，即这次调用的完整入参
  const seg = DISH_JS.slice(from, DISH_JS.indexOf('.then(', from));
  assert.ok(seg.indexOf('recipe: this.data.recipe') >= 0, 'generate 的入参要带 recipe');
});

t('★ 配额类失败要单成一档：QUOTA_EXHAUSTED，并说明「不用改代码」', () => {
  assert.ok(/function isQuotaError/.test(IMAGE_FN), '要有配额判定函数');
  assert.ok(/verdict = 'QUOTA_EXHAUSTED'/.test(IMAGE_FN), '要有 QUOTA_EXHAUSTED 结论');
  const seg = IMAGE_FN.slice(
    IMAGE_FN.indexOf("verdict = 'QUOTA_EXHAUSTED'"),
    IMAGE_FN.indexOf("verdict = 'QUOTA_EXHAUSTED'") + 600
  );
  assert.ok(/不用改代码/.test(seg), '要明确说不是代码问题');
  // 真实报错长这样：429 ...{"error":{"code":"1113","message":"余额不足或无可用资源包"}}
  ['余额不足', '无可用资源包'].forEach((w) => {
    assert.ok(IMAGE_FN.indexOf(w) >= 0, '要能认出服务商原文里的「' + w + '」');
  });
});

t('★ 配额失败不累加失败计数 —— 否则充完钱立刻点会被冷却挡住', () => {
  // 场景：用户充值后马上点生成，若这时弹出「已暂停 XX 秒」，看着像系统在为难他。
  // 而配额失败在服务商那里就被拒了，没花钱没占额度，计入冷却毫无收益。
  const syncSeg = IMAGE_FN.slice(IMAGE_FN.indexOf('[dishImage] generate failed'), IMAGE_FN.indexOf("GENERATE_FAILED'"));
  assert.ok(/isQuotaError\(msg\)/.test(syncSeg), '同步路径要区分是否配额错误');
  const collectSeg = IMAGE_FN.slice(IMAGE_FN.indexOf('[dishImage] 收图失败'), IMAGE_FN.indexOf('return \'\';', IMAGE_FN.indexOf('[dishImage] 收图失败')));
  assert.ok(/isQuotaError/.test(collectSeg), '异步收图路径也要区分');
});

t('★ 前端 toast 要能认出配额错误，别让人对着 429/1113 猜', () => {
  assert.ok(/function isQuotaMsg/.test(DISH_JS), '前端也要有配额判定');
  assert.ok(DISH_JS.indexOf('生图配额用完') >= 0, '要有「生图配额用完」的说法');
  const seg = DISH_JS.slice(DISH_JS.indexOf('生图配额用完') - 400, DISH_JS.indexOf('生图配额用完') + 400);
  assert.ok(/不用重新部署/.test(seg), '要明确说充完钱直接再点就行，不用重新部署');
});

t('mine 页：配图数取不到时要提示，不能静默显示 0', () => {
  assert.ok(MINE_JS.indexOf('.catch(() => null)') < 0, '别再静默 catch 成 null 了');
  assert.ok(/dishImageError/.test(MINE_JS), '要有取数失败的提示字段');
  assert.ok(MINE_WXML.indexOf('dishImageError') >= 0, 'WXML 要把它渲染出来，否则等于没写');
});

/* ---------- 10. 整周备注只挂在周日那一天的食谱里 ---------- */

t('★ 整周备注（全局备料）只展示在周日（weekday===0），其余 6 天不重复', () => {
  // 数据层 globalPrep 仍按原逻辑分布在 7 天（解析测试已锁），
  // 但展示层必须按「当天是不是周日」过滤，否则每天底部都重复同一段话。
  assert.ok(/(res\.day\.weekday === 0[\s\S]{0,120}globalPrepList)|(globalPrepList[\s\S]{0,120}res\.day\.weekday === 0)/.test(DAY_JS), 'day 详情页要按周日过滤整周备注');
  assert.ok(/(day\.weekday === 0[\s\S]{0,120}globalPrepList)|(globalPrepList[\s\S]{0,120}day\.weekday === 0)/.test(CARD_JS), 'day-card（校对页）也要按周日过滤整周备注');
});

module.exports = cases;

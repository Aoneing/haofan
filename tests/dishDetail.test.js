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

t('day.wxml：单日详情页打开主餐突出', () => {
  assert.ok(/highlight-key="\{\{true\}\}"/.test(DAY_WXML), 'day 页应打开 highlight-key');
});

t('today.wxml：「今天的饭」也要开主餐突出（用户实际看的是首页，不是 day 页）', () => {
  // 血泪教训：改动只开在 day 页，用户却在首页找效果，结论变成「没变化」。
  // 断言方式：找到含 highlight="today" 的那个标签，其属性区间里必须有 highlight-key。
  const m = /highlight="today"([\s\S]{0,220})/.exec(TODAY_WXML);
  assert.ok(m, 'today 页应有 highlight="today" 的 day-card');
  assert.ok(m[1].indexOf('highlight-key="{{true}}"') >= 0, '「今天的饭」必须开 highlight-key');
});

t('today.wxml：「明天」那块刻意不开主餐突出（错峰显示，避免首屏一片高亮）', () => {
  const m = /highlight="tomorrow"([\s\S]{0,220})/.exec(TODAY_WXML);
  assert.ok(m, 'today 页应有 highlight="tomorrow" 的 day-card');
  assert.ok(m[1].indexOf('highlight-key') < 0, '「明天」不要开，免得首屏两块都在喊');
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

t('单日视角开 prep-first：today「今天的饭」与 day 页都要', () => {
  const todayMain = /highlight="today"([\s\S]{0,260})/.exec(TODAY_WXML);
  assert.ok(todayMain, 'today 页应有「今天的饭」卡片');
  assert.ok(todayMain[1].indexOf('prep-first="{{true}}"') >= 0, '「今天的饭」要开 prep-first');
  assert.ok(/prep-first="\{\{true\}\}"/.test(DAY_WXML), 'day 页也要开 prep-first');
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

t('★ 前端：generate 要把做法一起送上去', () => {
  const from = DISH_JS.indexOf(".image('generate'");
  assert.ok(from > 0, '找不到 generate 的调用');
  // 取到那个 .then( 之前为止，即这次调用的完整入参
  const seg = DISH_JS.slice(from, DISH_JS.indexOf('.then(', from));
  assert.ok(seg.indexOf('recipe: this.data.recipe') >= 0, 'generate 的入参要带 recipe');
});

t('mine 页：配图数取不到时要提示，不能静默显示 0', () => {
  assert.ok(MINE_JS.indexOf('.catch(() => null)') < 0, '别再静默 catch 成 null 了');
  assert.ok(/dishImageError/.test(MINE_JS), '要有取数失败的提示字段');
  assert.ok(MINE_WXML.indexOf('dishImageError') >= 0, 'WXML 要把它渲染出来，否则等于没写');
});

module.exports = cases;

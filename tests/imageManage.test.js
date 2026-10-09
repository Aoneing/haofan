'use strict';

/**
 * 配图管理 + 「重复生成」防重的回归测试（2026-09-30）
 *
 * 起因是用户三连问：
 *   ① 点生成后退出页面，再进来没有任何「正在生成」的提示
 *   ② 于是又点了一次，没反应；再点第三次才生成 —— 体验很糟
 *   ③ 「我的里显示 12 张配图，我明明没生成这么多，是不是重复扣了次数？」
 *
 * ①②是前端状态没跟住服务端；③是真金白银的问题，必须能被回答。
 * 这组用例锁住的是三件事：
 *   · 退出再进来要自动接着等（不能让用户再点）
 *   · 同一道菜的并发/重复提交要被原子锁挡住（不能重复花钱）
 *   · 「花了几次」必须摊开给用户看（而不是靠解释）
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const IMAGE_FN = read('cloudfunctions/dishImage/index.js');
const DISH_JS = read('miniprogram/pages/dish/dish.js');
const STORE_JS = read('miniprogram/utils/imageStore.js');
const MINE_JS = read('miniprogram/pages/mine/mine.js');
const MINE_WXML = read('miniprogram/pages/mine/mine.wxml');
const GALLERY_JS = read('miniprogram/pages/gallery/gallery.js');
const GALLERY_WXML = read('miniprogram/pages/gallery/gallery.wxml');
const APP_JSON = read('miniprogram/app.json');

const cases = [];
const t = (name, fn) => cases.push({ name, fn });

/* ---------- 1. 退出再进来要能接着等 ---------- */

t('★ dish：重进页面会问服务端「还在生成吗」，而不是啥也不做', () => {
  assert.ok(/this\._resumeIfGenerating\(key\)/.test(DISH_JS), 'onShow 要调 _resumeIfGenerating');
  const from = DISH_JS.indexOf('_resumeIfGenerating(key) {');
  assert.ok(from > 0, '要有这个方法的定义');
  const seg = DISH_JS.slice(from, DISH_JS.indexOf('_refreshUrl(key) {'));
  assert.ok(/refreshState/.test(seg), '必须真的去问服务端，不能只看本地缓存');
  assert.ok(/pending|saving/.test(seg), '要认 pending / saving 两种中间态');
  assert.ok(/this\._startPoll\(key\)/.test(seg), '判定在生成就要恢复轮询');
});

t('★ dish：恢复时要给用户一句明确的话，别让他以为没点到', () => {
  const seg = DISH_JS.slice(DISH_JS.indexOf('_resumeIfGenerating(key) {'), DISH_JS.indexOf('_refreshUrl(key) {'));
  assert.ok(/还在生成中|已自动继续等待/.test(seg), '要有「还在生成 / 自动继续等待」的提示');
});

t('imageStore：hydrate 要把服务端的 states 存下来（以前整个丢掉了）', () => {
  assert.ok(/res\.states/.test(STORE_JS), 'resolve 返回的 states 要被消费');
  assert.ok(/function getState/.test(STORE_JS), '要能按 key 取状态');
});

t('★ imageStore：refreshState 必须绕开缓存 TTL 直接发请求', () => {
  assert.ok(/function refreshState/.test(STORE_JS), '要有 refreshState');
  const from = STORE_JS.indexOf('function refreshState');
  const seg = STORE_JS.slice(from, STORE_JS.indexOf('function reload'));
  // hydrate 在缓存新鲜时会直接 return Promise.resolve(cache) 不发请求 —— 这里不能那样
  assert.ok(/api\n?\s*\.image\('resolve'/.test(seg) || /\.image\('resolve'/.test(seg), '要直接调 resolve');
  assert.ok(statedExport(), 'exports 里要有 refreshState');
});
function statedExport() {
  return /module\.exports = \{[^}]*refreshState/.test(STORE_JS);
}

/* ---------- 2. 重复提交必须被挡住 ---------- */

t('★ 云函数：同一道菜要靠「原子抢占」防重，而不是读后判断', () => {
  assert.ok(/function claimSlot/.test(IMAGE_FN), '要有 claimSlot');
  const from = IMAGE_FN.indexOf('async function claimSlot');
  const seg = IMAGE_FN.slice(from, IMAGE_FN.indexOf('async function finishAndStore'));
  // add 带显式 _id：记录不存在时抢占，重复 key 会失败 ⇒ 后来者抢不到
  assert.ok(/\.add\(\{/.test(seg) && /_id: key/.test(seg), '不存在的记录要用 add({_id}) 抢占');
  // 已存在的记录要靠条件更新抢占：正在 pending 的那个会这里的条件，后来者 updated=0
  assert.ok(/status: _\.neq\('pending'\)/.test(seg), '已存在记录要用 status != pending 条件更新抢占');
});

t('★ 云函数：抢不到提交位就别调付费接口，并返回 reused 告诉前端', () => {
  const from = IMAGE_FN.indexOf('async function generate(event)');
  const seg = IMAGE_FN.slice(from, IMAGE_FN.indexOf('const ep = deriveAsyncEndpoints'));
  assert.ok(/claimSlot\(/.test(seg), 'generate 提交前要先抢位');
  assert.ok(/if \(!claimed\.ok\)/.test(seg), '抢不到要直接返回');
  const skimmed = IMAGE_FN.slice(IMAGE_FN.indexOf('if (!claimed.ok)'), IMAGE_FN.indexOf('const ep = deriveAsyncEndpoints'));
  assert.ok(/reused: true/.test(skimmed), '要返回 reused 标记');
  assert.ok(/不会重复消耗次数/.test(skimmed), '要把「不会重复消耗」这句话带给用户');
});

t('★ 云函数：submitCount 用 _.inc 原子累加，不能被并发写覆盖', () => {
  // 写成 upd.submitCount = _.inc(1)（赋值形式），因为 other 字段里已经不能再塞重复 key
  assert.ok(/submitCount = _\.inc\(1\)|submitCount: _\.inc\(1\)/.test(IMAGE_FN), '累加必须走 _.inc 而不是读出来 +1');
  assert.ok(/submitCount: incSubmit \? 1 : 0/.test(IMAGE_FN), '新建记录时也要初始化为 1（这一次就是付费的）');
});

t('前端：收到 reused 要显示「不会重复消耗次数」', () => {
  const seg = DISH_JS.slice(DISH_JS.indexOf('if (res && res.pending)'), DISH_JS.indexOf("NOT_CONFIGURED'"));
  assert.ok(/res\.reused/.test(seg), '要识别 reused');
  assert.ok(/不会重复消耗次数/.test(seg), '要把这句话显示给用户');
});

/* ---------- 3. 花没花冤枉钱，要看得见 ---------- */

t('★ 云函数：要有 list / remove 两个 action 并注册进 switch', () => {
  ['async function list(', 'async function remove('].forEach((sig) => {
    assert.ok(IMAGE_FN.indexOf(sig) > 0, '缺少 ' + sig);
  });
  const sw = IMAGE_FN.slice(IMAGE_FN.indexOf('switch (action)'), IMAGE_FN.indexOf('default:'));
  assert.ok(/case 'list':/.test(sw), 'switch 里要注册 list');
  assert.ok(/case 'remove':/.test(sw), 'switch 里要注册 remove');
});

t('★ 云函数：list 要返回 submitCount —— 这是回答「有没有多扣费」的唯一依据', () => {
  const from = IMAGE_FN.indexOf('async function list(event)');
  const seg = IMAGE_FN.slice(from, IMAGE_FN.indexOf('async function remove(event)'));
  assert.ok(/submitCount/.test(seg), '要有 submitCount');
  assert.ok(/failCount/.test(seg) && /lastError/.test(seg), '失败次数与原因也要给');
  // 排序放服务端做：集合没建索引，云端 orderBy 可能直接报错
  assert.ok(/items\.sort\(/.test(seg), '要在内存里排序，别用云端 orderBy');
});

t('★ 配图管理页要把「提交 N 次」摆出来，超过 1 次要标红', () => {
  assert.ok(/提交 \{\{item\.submitCount\}\} 次/.test(GALLERY_WXML), '每行要显示提交次数');
  assert.ok(/resubmitted/.test(GALLERY_JS), '要有「是否重复提交」的判定');
  const seg = GALLERY_WXML.slice(GALLERY_WXML.indexOf('gal-count'), GALLERY_WXML.indexOf('gal-count') + 220);
  assert.ok(/gal-count--warn/.test(seg), '重复提交要用告警色');
});

t('★ 配图管理页要给一个总量结论，不用用户自己数', () => {
  assert.ok(/totalGenerations/.test(GALLERY_JS), '要有提交总次数');
  assert.ok(/extraGenerations/.test(GALLERY_JS), '要算出「超出一道菜一次」的部分');
  assert.ok(/{{extraGenerations}}/.test(GALLERY_WXML), '总量要渲染出来');
  assert.ok(/没有重复提交/.test(GALLERY_WXML), '没问题时也要明确说没问题，别留悬念');
});

t(' gallery：能删除配图（图不对版时的干净解法）', () => {
  assert.ok(/api\n?\s*\.image\('remove'/.test(GALLERY_JS), '要调 remove');
  assert.ok(/删除这张配图？/.test(GALLERY_JS), '删除前要确认');
});

t('★ gallery：页面自己也要轮询收异步结果（不能只被动看库状态）', () => {
  // 2026-10-08 用户实机反馈：配图管理里一堆菜一直显示「生成中」，很久都不出图，
  // 其中一条 lastError 是「任务超时：等待超过 10 分钟仍未出图（taskId=...）」。
  // 根因：生图 30–180 秒超过云函数单次执行上限，generate 只提交任务就返回，
  //   真正的结果回收靠 resolve({collect:true})顺带问一句 —— 而**只有菜品详情页会问**。
  //   本页面原先只拉 list 看库里的 status，库里就永远停在 pending，用户干等。
  assert.ok(/_autoPoll/.test(GALLERY_JS), '要有 _autoPoll：按是否存在 pending/saving 决定要不要轮询');
  assert.ok(
    /status === 'pending' \|\| it\.status === 'saving'/.test(GALLERY_JS) || /'pending' \|\| i\.status === 'saving'/.test(GALLERY_JS),
    '要按 pending/saving 状态判断是否还有任务在跑'
  );
  assert.ok(
    /image\(\s*'resolve'\s*,\s*\{[^}]*collect:\s*true/.test(GALLERY_JS),
    '轮询必须用 resolve({collect:true}) 让云函数顺手收图'
  );
  assert.ok(/image\('resolve'/.test(GALLERY_JS), '要调 resolve');
  assert.ok(/_pollTimer/.test(GALLERY_JS) && /clearTimeout/.test(GALLERY_JS), '轮询要有定时器且能停');
  assert.ok(/onHide\(\)[\s\S]*_stopPoll/.test(GALLERY_JS), '离开页面要停轮询，别后台空转烧云调用');
  assert.ok(/onUnload\(\)[\s\S]*_stopPoll/.test(GALLERY_JS), '销毁页面也要停轮询');
  assert.ok(/onShow\(\)[\s\S]*_autoPoll/.test(GALLERY_JS), '进页面要按需起轮询');
  // 节奏要与菜品详情页一致，避免两处策略不同
  assert.ok(/POLL_INTERVAL_MS\s*=\s*3000/.test(GALLERY_JS), '前段 3 秒密轮询');
  assert.ok(/POLL_MAX_MS\s*=\s*5 \* 60 \* 1000/.test(GALLERY_JS), '最多等 5 分钟（云函数 10 分钟才判超时，前端要更早收手）');
});

t('★ gallery：失败/超时的菜要有「重新生成」出口', () => {
  // 云函数超时会写 failed + lastError，用户在这个页面上没有任何办法重开一局
  assert.ok(/retry\(e\)/.test(GALLERY_JS), '要实现 retry');
  assert.ok(/image\('generate'/.test(GALLERY_JS), 'retry 要重新提交 generate');
  assert.ok(
    /wx:if="\{\{item\.status === 'failed' \|\| item\.status === 'expired'\}\}"/.test(GALLERY_WXML),
    '只有失败/超时的行才显示「重新生成」'
  );
  assert.ok(/bindtap="retry"/.test(GALLERY_WXML), '按钮要绑定 retry');
  assert.ok(/gal-retry/.test(GALLERY_WXML), '要有样式类');
  assert.ok(/已提交，正在生成/.test(GALLERY_JS), '提交后要给出反馈');
  // expired 必须有自己的文案，不能落回默认的「无图」
  assert.ok(/expired:\s*\{\s*label:\s*'超时失败'/.test(GALLERY_JS), 'expired 状态要有独立文案「超时失败」');
});

t('入口：mine 页「张配图」可点进配图管理', () => {
  assert.ok(/goGallery/.test(MINE_JS), '要有跳转方法');
  assert.ok(MINE_JS.indexOf("'/pages/gallery/gallery'") > 0, '路径要对');
  assert.ok(MINE_WXML.indexOf('bindtap="goGallery"') > 0, 'WXML 要绑上');
  assert.ok(
    /<view class="gal-card"[^>]*bindtap="goGallery">[\s\S]*?张配图/.test(MINE_WXML),
    '「张配图」整卡（深色配图管理卡）要能点进配图管理'
  );
});

t('app.json：gallery 页面要注册（漏了会 navigateTo 失败且没日志）', () => {
  const app = JSON.parse(APP_JSON);
  assert.ok(app.pages.indexOf('pages/gallery/gallery') >= 0, 'pages 里要有 gallery');
});

t('★ gallery：删除后要立刻从列表移除 + 清缓存 + 强制刷新（否则命中 60s 旧缓存图还在）', () => {
  // 2026-10-09 实机：点删除确认后图片仍在、按钮变灰。
  // 根因：list 默认走 60s 读缓存，remove 成功后 this.load() 命中旧缓存仍含已删图。
  // 必须：①本地乐观移除该项 ②清 list 缓存 ③load(true) 强制 noCache 刷新。
  const from = GALLERY_JS.indexOf('remove(e) {');
  const seg = GALLERY_JS.slice(from, GALLERY_JS.indexOf('retry(e) {'));
  assert.ok(/filter\(\(it\) => it\.key !== key\)/.test(seg), '要本地乐观移除该项，图立即消失，不依赖网络/缓存');
  assert.ok(/api\s*\.clearCache\(\)/.test(seg), '要清掉 list 读缓存，否则 60s TTL 内重进页面又拉回旧图');
  assert.ok(/load\(true\)/.test(seg), '要 load(true) 强制 noCache 刷新与后端对齐');
});

module.exports = cases;

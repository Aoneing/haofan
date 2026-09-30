'use strict';

/**
 * 「刚点生成就被判成任务超时」的回归测试（2026-09-30）
 *
 * 现象：用户点生成 → 几秒后前端弹「这次任务超时了，请再点一次生成」。
 *       再点也没用：一直被告知「已在生成中」，这道菜永远出不了图。
 *
 * 真因是两处叠加，而且互相掩盖：
 *   ① markDoc 用了 doc().set() —— set 是**整体覆盖**（SDK 源码里 merge: false），
 *      generate 提交成功后补写 taskId 那一下，把 pendingAt / submitCount 全抹掉了。
 *   ② 超时判定写的是 `Date.now() - toMs(pendingAt) > TASK_TTL_MS`；
 *      pendingAt 一没，toMs 返回 0，差值 ≈ 56.8 年 ⇒ 刚提交就必然判超时。
 *   ③ 判成 expired 之后库里 status 还停在 pending ⇒ 原子锁的
 *      where(status != 'pending') 永远匹配不到 ⇒ 重开不了局，死循环。
 *
 * 这组用例把三件事分别钉死，任何一条退回去都必须立刻报红。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CF = read('cloudfunctions/dishImage/index.js');
const DISH_JS = read('miniprogram/pages/dish/dish.js');

const cases = [];
const t = (name, fn) => cases.push({ name, fn });

/**
 * 把云函数里的 toMs / ageOf 抠出来真跑一遍。
 * 为什么不用正则断言凑数：这次的 bug 是**数值语义**问题（0 当成了「很久以前」），
 * 只有真跑一遍才能证明「缺失时间不会被判成超时」。
 */
function loadTimeHelpers() {
  const from = CF.indexOf('/** Date / ISO 字符串');
  const to = CF.indexOf('/** 读一条配图记录');
  assert.ok(from > 0 && to > from, '要能定位到 toMs / ageOf 的定义段');
  const seg = CF.slice(from, to);
  const sandbox = {};
  vm.runInNewContext(seg + '\n__out = { toMs: toMs, ageOf: ageOf };', sandbox, {
    filename: 'time-helpers.js',
  });
  return sandbox.__out;
}

/** 去掉注释：判断「代码里有没有某种写法」时，注释里的同名文字会误伤断言 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 取 markDoc —— 连同它前面的注释一起（注释里写了踩坑证据，也要被断言覆盖） */
function markDocBody() {
  const from = CF.indexOf('async function markDoc(key, data) {');
  assert.ok(from > 0, '要有 markDoc');
  const start = CF.lastIndexOf('/**', from); // 函数上方的文档注释
  return CF.slice(start, CF.indexOf('/**', from + 40));
}

/** 取 resolve 里 collect 循环体 */
function collectBody() {
  const from = CF.indexOf('if (event.collect) {');
  assert.ok(from > 0, 'resolve 要有 collect 分支');
  return CF.slice(from, CF.indexOf('} else {', from));
}

/** 取 prepare 里的幂等判定段 */
function prepareGuard() {
  const from = CF.indexOf('const prev = await readDoc(key);');
  assert.ok(from > 0, 'prepare 要有幂等判定');
  return CF.slice(from, CF.indexOf('const apiUrl = process.env.IMAGE_API_URL;'));
}

/* ---------- 1. 时间语义：缺失 ≠ 很久以前 ---------- */

t('★ ageOf：时间字段缺失时必须返回「不知道」，不能返回天文数字', () => {
  const h = loadTimeHelpers();
  assert.strictEqual(h.ageOf(undefined), -1, 'undefined → -1');
  assert.strictEqual(h.ageOf(null), -1, 'null → -1');
  assert.strictEqual(h.ageOf(''), -1, '空串 → -1');
  assert.ok(h.ageOf(new Date()) >= 0, '有 Date 时要返回真实毫秒差');
  assert.ok(h.ageOf(Date.now()) >= 0, '时间戳也要认');
});

t('★ 裸用 toMs 会误判超时，ageOf 不会（这条就是 bug 的数值复现）', () => {
  const h = loadTimeHelpers();
  const TTL = 10 * 60 * 1000;
  // 旧写法：pendingAt 一没就变成「56.8 年前」
  const bad = Date.now() - h.toMs(undefined);
  assert.ok(bad > TTL, '前提：旧写法确实会误判（差值应远大于 TTL）');
  // 新写法：缺失时是 -1，不应判成超时
  assert.ok(!(h.ageOf(undefined) > TTL), 'ageOf 缺失时不能判成超时');
});

t('★ 刚提交（0 秒）的任务绝不能被判成超时', () => {
  const h = loadTimeHelpers();
  const TTL = 10 * 60 * 1000;
  const justNow = h.ageOf(new Date());
  assert.ok(justNow >= 0 && justNow < TTL, '刚提交应落在窗口内');
  const tenMinAgo = h.ageOf(new Date(Date.now() - TTL - 1000));
  assert.ok(tenMinAgo > TTL, '真的超过 10 分钟才该判超时');
});

/* ---------- 2. markDoc 不能整体覆盖 ---------- */

t('★ markDoc 必须先走 update（局部更新），set 只能当兜底', () => {
  const body = markDocBody();
  const iUpdate = body.indexOf('.update(');
  const iSet = body.indexOf('.set(');
  assert.ok(iUpdate > 0, '必须有 update');
  assert.ok(iSet > 0, '保留 set 兜底（记录不存在时创建）');
  assert.ok(iUpdate < iSet, '★ update 必须在 set 之前 —— 主路径不能是整体覆盖的 set');
});

t('markDoc：update 更新到 0 条时要退回 set（记录还不存在）', () => {
  const body = markDocBody();
  assert.ok(/updated/.test(body), '要读更新的条数');
  assert.ok(/=== 0|throw new Error/.test(body), 'updated 为 0 时要触发兜底');
});

t('markDoc：注释里要写清楚 set 会抹字段这件事，别让后人又改回去', () => {
  const body = markDocBody();
  assert.ok(/merge: false/.test(body), '注释要给出 SDK 源码层面的证据（set 是整体覆盖）');
  assert.ok(/pendingAt/.test(body), '注释要点名被抹掉的字段');
});

/* ---------- 3. 超时判定必须防误伤 ---------- */

t('★ resolve 的超时判定必须用 ageOf，不许再裸写 Date.now() - toMs()', () => {
  const body = stripComments(collectBody());
  assert.ok(/ageOf\(doc\.pendingAt\)/.test(body), '要用 ageOf');
  assert.ok(
    !/Date\.now\(\)\s*-\s*toMs\(/.test(body),
    '不能出现裸写的时间差——缺失时会被算成 56.8 年'
  );
});

t('★ 判成 expired 时必须把库里的状态推进，否则这道菜永远出不了图', () => {
  const body = collectBody();
  const from = body.indexOf("states[uniq[i]] = 'expired'");
  assert.ok(from > 0, '要有 expired 分支');
  const seg = body.slice(from, body.indexOf('continue', from) + 10);
  assert.ok(/markDoc\(/.test(seg), '★ 判超时必须回写数据库');
  assert.ok(/status:\s*'failed'/.test(seg), '要把 status 从 pending 推走，让原子锁能再次抢到');
});

t('pendingAt 缺失的历史记录要补写基准时间（自愈，否则计时永远算不出来）', () => {
  const body = collectBody();
  assert.ok(/pendingAge < 0/.test(body), '要识别「不知道有多久」这一种情况');
  assert.ok(/pendingAt:\s*new Date\(\)/.test(body), '补写基准时间');
});

/* ---------- 4. prepare 的复用窗口同样不能拿缺失时间比大小 ---------- */

t('★ prepare：pendingAt 缺失时不复用（不拦人），也不当成已超时', () => {
  const seg = stripComments(prepareGuard());
  assert.ok(/pendingAge >= 0/.test(seg), '★ 必须先判「有没有时间」再比大小');
  assert.ok(!/Date\.now\(\)\s*-\s*toMs\(/.test(seg), '不能裸写时间差');
});

t('prepare：saving / 冷却窗口也不能拿缺失时间比大小', () => {
  const seg = prepareGuard();
  assert.ok(/savingAge >= 0/.test(seg), 'saving 窗口要先判有没有时间');
  assert.ok(/failAge >= 0/.test(seg), '失败冷却窗口要先判有没有时间');
});

/* ---------- 5. 前端提示 ---------- */

t('★ dish：expired 提示要说清「可以重开一局」，不能只让用户干点', () => {
  const from = DISH_JS.indexOf("state === 'expired'");
  assert.ok(from > 0, '要有 expired 分支');
  const seg = DISH_JS.slice(from, DISH_JS.indexOf('return false;', from));
  assert.ok(/重新提交|再点一次/.test(seg), '要告诉用户下一步该做什么');
  assert.ok(/this\._diagDirty = true/.test(seg), '顺手刷新诊断面板，方便看 lastError 原文');
});

module.exports = cases;

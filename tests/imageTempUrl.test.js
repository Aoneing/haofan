'use strict';

/**
 * 配图临时链接：有效期与缓存 TTL 的回归测试。
 *
 * 背景（2026-09-27 定位）——「图区空白 + 点大图一直转圈」的真根因：
 *  官方 getTempFileURL 文档：公有读文件的链接**不过期**，私有读文件的链接**十分钟有效期**。
 *  本环境存储权限被免费套餐锁死为「仅创建者可读写」⇒ 私有读 ⇒ 链接只有 10 分钟。
 *
 *  而 maxAge 只在 fileList 传**对象** `{ fileID, maxAge }` 时才会被上送；
 *  传裸字符串 `'cloud://xxx'` 时 SDK 只发 `{ fileid }`，不带 max_age，
 *  服务端就按默认 600 秒（10 分钟）签发（见 @cloudbase/node-sdk downloadFile 的 maxAge: 600）。
 *
 *  旧代码两处叠加：① 传裸字符串 ⇒ 链接 10 分钟死；② 前端 TTL 写 30 分钟
 *  ⇒ 中间 20 分钟一直在用死链接渲染，且 onShow 用 get() 直读缓存绕开了 TTL 判断，
 *  导致「退出重进页面也恢复不了」。
 *
 * 这组用例锁死三条纪律，防止回退：
 *  1. 云函数必须显式申请足够长的 maxAge（传对象，不传裸字符串）
 *  2. 前端 TTL 必须小于链接实际有效期
 *  3. 喂给 <image> 的链接必须走 TTL 判断（getFresh），不能走 get()
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CF_SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/dishImage/index.js'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/imageStore.js'), 'utf8');
const DISH_SRC = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/dish/dish.js'), 'utf8');
const THUMB_SRC = fs.readFileSync(path.join(ROOT, 'miniprogram/components/dish-thumb/dish-thumb.js'), 'utf8');

const cases = [];
const t = (name, fn) => cases.push({ name, fn });

/* ---------- 1. 云函数：签发有效期 ---------- */

t('云函数 toTempUrls 传 { fileID, maxAge } 对象，不传裸字符串（否则丢掉 maxAge）', () => {
  assert.ok(
    /fileList:\s*chunk\.map\(\(fileID\)\s*=>\s*\(\{\s*fileID,\s*maxAge:/s.test(CF_SRC),
    'toTempUrls 必须传对象才能带上 maxAge；传裸字符串会让服务端按默认 600 秒签发'
  );
});

t('云函数申请的有效期远大于前端 TTL（默认 6 小时）', () => {
  assert.ok(
    /IMAGE_URL_MAX_AGE \|\| 6 \* 3600/.test(CF_SRC),
    '应显式申请 6 小时有效期，不能依赖服务端默认值'
  );
});

t('云函数保留「换不到链接」的可诊断日志（含 status / errMsg）', () => {
  assert.ok(/未返回链接 fileID=/.test(CF_SRC), '换不到链接时要 warn，便于下次直接看日志定位');
  assert.ok(/errMsg=/.test(CF_SRC), '应打印 errMsg，才能区分权限拒绝与文件不存在');
});

t('云函数不再遗留「临时链接约 2 小时有效」的错误注释', () => {
  assert.ok(!/约 2 小时/.test(CF_SRC), '私有读链接是 10 分钟，注释不能继续写 2 小时');
});

/* ---------- 2. 前端：TTL 与读缓存纪律 ---------- */

t('imageStore 暴露 getFresh 并且导出了它', () => {
  assert.ok(/function getFresh/.test(STORE_SRC));
  assert.ok(/module\.exports\s*=\s*\{[^}]*getFresh/.test(STORE_SRC));
});

t('imageStore TTL 小于链接实际有效期（5 分钟 < 10 分钟）', () => {
  const m = STORE_SRC.match(/URL_TTL_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
  assert.ok(m, '应从 URL_TTL_MS 定义处解析出分钟数');
  const minutes = Number(m[1]);
  assert.ok(minutes <= 10, 'TTL 必须 <= 私有读链接有效期 10 分钟，当前 ' + minutes + ' 分钟');
  assert.ok(minutes > 0, 'TTL 应大于 0');
});

t('dish.js onShow 用 getFresh 取「可立即渲染」的链接，不用 get 直读缓存', () => {
  assert.ok(/imageStore\.getFresh\(key\)/.test(DISH_SRC), 'onShow 应立即渲染值必须判 TTL');
  assert.ok(
    !/const cached = imageStore\.get\(key\)/.test(DISH_SRC),
    '不能再用 get() 直读缓存，它会把过期链接交出去渲染成 403 空白'
  );
});

t('dish-thumb 自愈重试次数 > 1（可恢复故障不会一次就放弃）', () => {
  const m = THUMB_SRC.match(/MAX_RETRY\s*=\s*(\d+)/);
  assert.ok(m, '应有 MAX_RETRY 常量');
  assert.ok(Number(m[1]) > 1, '只允许重试 1 次时，错过窗口就永久空白，须 > 1');
});

t('dish-thumb 加载失败时打印可诊断日志', () => {
  assert.ok(/\[dish-thumb\] 图片加载失败/.test(THUMB_SRC), '应打印 key / src / detail 便于下次直接定位');
});

t('dish-thumb 的 detached 在 lifetimes 内且清理定时器', () => {
  assert.ok(
    /lifetimes:\s*\{[\s\S]*?detached\(\)\s*\{[\s\S]*?clearTimeout[\s\S]*?\},\s*\},\s*\n\s*methods:/.test(
      THUMB_SRC
    ),
    'detached 属于 lifetimes，写进 methods 不会生效，定时器会泄漏'
  );
});

t('dish-thumb 不再使用「整个周期只自愈一次」的 _retried 标记', () => {
  assert.ok(!/this\._retried\b/.test(THUMB_SRC), '_retried 是导致「永久空白」的旧实现');
});

/* ---------- 3. 行为：TTL 到期后不再用死链接渲染 ---------- */

t('行为：链接超过 TTL 后 getFresh 返回空、hydrate 会重取（老 bug 不再复现）', async () => {
  const Module = require('module');
  const realNow = Date.now;
  let NOW = 1700000000000;
  Date.now = () => NOW;

  const apiPath = require.resolve(path.join(ROOT, 'miniprogram/utils/api.js'));
  const cachedApi = require.cache[apiPath];
  let resolveCalls = 0;
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: {
      image: (action, data) => {
        resolveCalls += 1;
        const map = {};
        (data.keys || []).forEach((k) => {
          map[k] = 'https://x.tcb.qcloud.la/a.jpg?sign=' + NOW;
        });
        return Promise.resolve({ ok: true, map, files: {}, missing: [] });
      },
    },
  };
  const storePath = require.resolve(path.join(ROOT, 'miniprogram/utils/imageStore.js'));
  const cachedStore = require.cache[storePath];
  delete require.cache[storePath];

  try {
    const store = require(storePath);
    const KEY = '葱香肉松蛋卷';

    await store.hydrate([KEY]);
    const first = store.get(KEY);
    assert.ok(first, '首次应换到链接');

    // TTL 内：不重取，getFresh 给链接
    NOW += 2 * 60 * 1000;
    resolveCalls = 0;
    await store.hydrate([KEY]);
    assert.strictEqual(resolveCalls, 0, 'TTL 内不应重取');
    assert.strictEqual(store.getFresh(KEY), first, 'TTL 内 getFresh 应给出链接');

    // 超过 TTL：必须不再交出去渲染，且 hydrate 要换新的
    NOW += 5 * 60 * 1000;
    assert.strictEqual(store.getFresh(KEY), '', '★ 超过 TTL 后 getFresh 必须返回空（不拿死链接渲染）');
    resolveCalls = 0;
    await store.hydrate([KEY]);
    assert.strictEqual(resolveCalls, 1, '★ 超过 TTL 后应重取新链接');
    assert.ok(store.getFresh(KEY) && store.getFresh(KEY) !== first, '★ 重取后应拿到新链接');
  } finally {
    Date.now = realNow;
    if (cachedApi) require.cache[apiPath] = cachedApi;
    else delete require.cache[apiPath];
    if (cachedStore) require.cache[storePath] = cachedStore;
    else delete require.cache[storePath];
  }
});

module.exports = cases;

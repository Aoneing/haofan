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
const DISH_WXML = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/dish/dish.wxml'), 'utf8');
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

/* ---------- 1b. 自检能力：这个故障反复误判，必须能一步看到结论 ---------- */

t('云函数提供 selfcheck action（一站式诊断，含真实 HTTPS 探测）', () => {
  assert.ok(/case 'selfcheck'/.test(CF_SRC), '缺少 selfcheck 分发');
  assert.ok(/async function selfcheck/.test(CF_SRC), '缺少 selfcheck 实现');
  assert.ok(/function headOrGet/.test(CF_SRC), '必须真的 GET 一次换出的链接才能区分服务端/小程序端问题');
});

t('selfcheck 带「部署版本指纹」，能识别云端跑的是不是旧代码', () => {
  assert.ok(/hasMaxAge/.test(CF_SRC), '应自检 maxAge 修复是否在运行代码里');
  assert.ok(
    /DEPLOYED_CODE_IS_OLD/.test(CF_SRC),
    '若云端是旧代码必须明确报出来，避免又白排查一轮'
  );
});

t('selfcheck 能区分 CDN 不可达 / 403 / 404 / 服务端全好', () => {
  ['CDN_UNREACHABLE', 'HTTP_403', 'HTTP_404', 'SERVER_SIDE_OK', 'TEMP_URL_FAILED'].forEach((v) => {
    assert.ok(CF_SRC.indexOf("'" + v + "'") >= 0, '缺少结论分支 ' + v);
  });
});

/* ---------- 1c. cloudPath 合法性（403 的真根因） ---------- */

t('★ cloudPath 不再用 encodeURIComponent（% 是非法字符，会导致私有桶 403）', () => {
  assert.ok(
    !/encodeURIComponent\(key\)/.test(CF_SRC),
    'encodeURIComponent 会把中文变成 %E8%91%B1…，而 % 不在 cloudPath 允许字符集内'
  );
  assert.ok(/const cloudPath = safeCloudPath\(key, packed\.ext\)/.test(CF_SRC), '应改用 safeCloudPath');
});

t('safeCloudPath 只产出合法字符（数字字母 / 中文 / ! - _ . *）', () => {
  assert.ok(/function safeCloudPath/.test(CF_SRC), '缺少 safeCloudPath');
  assert.ok(/\\u4e00-\\u9fa5/.test(CF_SRC), '应保留中文（官方允许中文，不需要编码）');
  // 真跑一遍：把函数从源码里抠出来执行，确保正则确实有效
  const fn = CF_SRC.match(/function safeCloudPath[\s\S]*?\n}/);
  assert.ok(fn, '未能从源码提取 safeCloudPath');
  // eslint-disable-next-line no-new-func
  const safeCloudPath = new Function(fn[0] + '; return safeCloudPath;')();
  const samples = ['葱香肉松蛋卷', '番茄炒蛋', 'A&B 早餐(x)', '%E8%91%B1', '菜 名/斜杠', ''];
  samples.forEach((k) => {
    const name = safeCloudPath(k, 'jpg').slice('dish-images/'.length);
    const illegal = name.match(/[^0-9A-Za-z\u4e00-\u9fa5!\-_.*]/g);
    assert.ok(!illegal, JSON.stringify(k) + ' → ' + name + ' 含非法字符 ' + JSON.stringify(illegal));
  });
});

t('safeCloudPath 生成的路径不含百分号', () => {
  const fn = CF_SRC.match(/function safeCloudPath[\s\S]*?\n}/);
  // eslint-disable-next-line no-new-func
  const safeCloudPath = new Function(fn[0] + '; return safeCloudPath;')();
  ['葱香肉松蛋卷', '%E8%91%B1', 'a%20b'].forEach((k) => {
    assert.ok(safeCloudPath(k, 'jpg').indexOf('%') < 0, JSON.stringify(k) + ' 仍含 %');
  });
});

t('selfcheck 含 ASCII 对照实验（能把「路径问题」与「权限问题」分开）', () => {
  assert.ok(/ascii-probe/.test(CF_SRC), '缺少纯 ASCII 探针文件的对照');
  assert.ok(/report\.asciiProbe/.test(CF_SRC), '应把对照结果放进报告');
  assert.ok(/BAD_CLOUD_PATH/.test(CF_SRC), '缺少「路径有问题」的结论分支');
});

t('selfcheck 对同一 fileID 做 maxAge A/B 对照', () => {
  assert.ok(/ab-maxage/.test(CF_SRC), '应同时用「带 maxAge」和「裸字符串」换链接各测一次');
});

t('selfcheck 把 pending 与「从没生成过」分开（否则会误报成故障）', () => {
  assert.ok(/GENERATING/.test(CF_SRC), 'pending 应报 GENERATING');
  assert.ok(/LAST_FAILED/.test(CF_SRC), 'failed 应报 LAST_GENERATE_FAILED');
  assert.ok(
    /one\.status === 'pending'/.test(CF_SRC),
    '必须按 status 区分，不能一律当成 NO_IMAGE_RECORDS'
  );
  // 文案里夹了 markdown 星号（**正在生成中**），用宽松匹配，别被排版改动打断
  assert.ok(/正在生成中[\s\S]{0,8}不是故障/.test(CF_SRC), '应明确告诉用户这不是故障');
});

/* ---------- 1d. 异步生图（同步等图必然被强杀） ---------- */

t('★ 生图走异步：提交任务后立即返回，不再同步 await 生图', () => {
  // GLM-Image 生图 30–180 秒 > 云函数执行超时上限 ⇒ 同步 await 会被强杀，
  // 表现为记录永远停在 pending（既不 ready 也不 failed）。实测卡了 364 秒。
  assert.ok(/async\/images\/generations/.test(CF_SRC), '应提交到智谱异步端点 async/images/generations');
  assert.ok(/async-result/.test(CF_SRC), '应有按 task id 取结果的逻辑');
  assert.ok(/taskId/.test(CF_SRC), 'taskId 必须落库，否则下次进来认不出任务');
});

t('异步端点由 IMAGE_API_URL 推导（用户不用改环境变量）', () => {
  const fn = CF_SRC.match(/function deriveAsyncEndpoints[\s\S]*?\n}/);
  assert.ok(fn, '未能从源码提取 deriveAsyncEndpoints');
  // eslint-disable-next-line no-new-func
  const derive = new Function(fn[0] + '; return deriveAsyncEndpoints;')();
  const ep = derive('https://open.bigmodel.cn/api/paas/v4/images/generations');
  assert.strictEqual(
    ep.submit,
    'https://open.bigmodel.cn/api/paas/v4/async/images/generations',
    '提交端点推导错误：' + ep.submit
  );
  assert.strictEqual(
    ep.resultPrefix,
    'https://open.bigmodel.cn/api/paas/v4/async-result/',
    '查询端点推导错误：' + ep.resultPrefix
  );
  assert.ok(ep.asyncCapable, '智谱的 URL 应判定为支持异步');
  // 已经是异步 URL 时不重复插入 async
  const ep2 = derive('https://open.bigmodel.cn/api/paas/v4/async/images/generations');
  assert.strictEqual(ep2.submit, 'https://open.bigmodel.cn/api/paas/v4/async/images/generations');
  // 非智谱的网关：推不出异步 ⇒ 走同步兜底，不能把功能堵死
  const ep3 = derive('https://example.com/v1/images/generations');
  assert.strictEqual(ep3.asyncCapable, false, '非智谱 URL 应判定为不支持异步并回落同步');
});

t('异步结果解析兼容多种字段命名（image_result / data / images）', () => {
  const fn = CF_SRC.match(/function pickImageItem[\s\S]*?\n}/);
  assert.ok(fn, '未能从源码提取 pickImageItem');
  // eslint-disable-next-line no-new-func
  const pick = new Function(fn[0] + '; return pickImageItem;')();
  const shapes = [
    { image_result: [{ url: 'https://a/1.png' }] },
    { data: [{ url: 'https://a/2.png' }] },
    { images: [{ url: 'https://a/3.png' }] },
    { image_result: [{ b64_json: 'AAA' }] },
    { url: 'https://a/4.png' },
  ];
  shapes.forEach((s) => {
    const got = pick(s);
    assert.ok(got && (got.url || got.b64_json), '未能解析：' + JSON.stringify(s));
  });
  assert.strictEqual(pick({}), null, '空结果应返回 null');
  assert.strictEqual(pick(null), null, 'null 应返回 null');
});

t('★ 僵尸 pending（无 taskId）必须允许立刻重新提交', () => {
  // 旧同步模式被强杀留下的记录没有 taskId，若和「异步任务进行中」混为一谈，
  // 就会被幂等窗口一直挡住 ⇒ 这道菜永远出不了图。
  assert.ok(
    /prev\.status === 'pending' && prev\.taskId/.test(CF_SRC),
    '幂等窗口只能对「带 taskId 的异步任务」生效'
  );
  assert.ok(/const TASK_TTL_MS/.test(CF_SRC), '应有独立的任务复用窗口常量');
  assert.ok(!/PENDING_WINDOW_MS/.test(CF_SRC), '旧的 3 分钟 pending 窗口会挡住僵尸记录的重生');
});

t('resolve 支持 collect：轮询时顺手收一次异步结果', () => {
  assert.ok(/event\.collect/.test(CF_SRC), 'resolve 应支持 collect 参数');
  assert.ok(/async function tryCollect/.test(CF_SRC), '缺少收图函数 tryCollect');
  assert.ok(/task_status/.test(CF_SRC), '应按 task_status 判断 SUCCESS / PROCESSING / FAIL');
});

t('selfcheck 输出云函数的真实超时配置（判断同步等图会不会被强杀）', () => {
  assert.ok(/async function selfcheck\(event, context\)/.test(CF_SRC), 'selfcheck 需要 context 才能读到超时配置');
  assert.ok(/time_limit_in_ms/.test(CF_SRC), '应读取 context.time_limit_in_ms');
  assert.ok(/exports\.main = async \(event, context\)/.test(CF_SRC), '入口要把 context 传下去');
  assert.ok(/report\.runtime/.test(CF_SRC), '超时配置应进报告，便于一次确认');
});

t('僵尸 pending 在诊断里有独立结论（不与「生成中」混淆）', () => {
  assert.ok(/STUCK_PENDING/.test(CF_SRC), '缺少僵尸 pending 的结论分支');
  assert.ok(/doc\.taskId/.test(CF_SRC), '应按有没有 taskId 区分「异步进行中」与「被强杀的僵尸」');
});

t('前端轮询带 collect，且窗口覆盖 180 秒生图上限', () => {
  assert.ok(/collect: true/.test(DISH_SRC), '轮询 resolve 必须带 collect，否则永远收不到图');
  const max = DISH_SRC.match(/POLL_MAX_MS = (\d+)/);
  assert.ok(max, '未找到 POLL_MAX_MS');
  assert.ok(Number(max[1]) >= 180000, '轮询窗口 ' + max[1] + 'ms 小于生图上限 180 秒，会提前放弃');
});

t('诊断面板不输出 undefined（没探测过就不显示 HTTP 结果）', () => {
  assert.ok(
    /typeof r0\.httpStatus === 'number'/.test(DISH_SRC),
    '未探测时显示 undefined 会误导，应先判断类型'
  );
  assert.ok(/asciiProbe/.test(DISH_SRC), '应突出显示存储链路对照结果');
});

t('dish 页按需求移除了「图不显示？点这里诊断」入口文字', () => {
  assert.ok(!/图不显示？点这里诊断/.test(DISH_WXML), 'WXML 不应再显示诊断入口文字');
  // 诊断逻辑仍在 js 里保留（toggleDiag/selfcheck），只是不再暴露入口，方便日后复用
  assert.ok(/toggleDiag/.test(DISH_SRC), 'toggleDiag 方法应保留');
  assert.ok(/selfcheck/.test(DISH_SRC), '诊断面板应仍调用 selfcheck');
});

t('dish-thumb 把加载失败上报给页面（供诊断面板计数）', () => {
  assert.ok(/triggerEvent\('imgerror'/.test(THUMB_SRC), '应 triggerEvent 上报');
  assert.ok(/bindimgerror="onThumbError"/.test(DISH_WXML), '页面应监听 imgerror');
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

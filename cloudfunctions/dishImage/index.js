'use strict';

const cloud = require('wx-server-sdk');
const https = require('https');
const http = require('http');
const net = require('net');
const fs = require('fs'); // selfcheck 用来自检「云端跑的代码是不是最新版」

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

/**
 * 配图三层方案：
 *  1. resolve   —— 查 dishImages 集合（_id = 归一化菜名），命中即返回云存储 fileID
 *  2. generate  —— 调 OpenAI 兼容生图接口（images/generations），生成后上传云存储并落库
 *  3. 前端兜底  —— 未命中且未配置生图服务时，用菜名首字文字占位
 *
 * 生图服务配置（云函数「配置 → 环境变量」）：
 *  IMAGE_API_URL       例如 https://open.bigmodel.cn/api/paas/v4/images/generations
 *                      注意：云函数在境内节点，api.openai.com 不可达，必须用境内兼容网关
 *  IMAGE_API_KEY       对应 Bearer Token
 *  IMAGE_API_MODEL     可选，默认 gpt-image-1
 *  IMAGE_API_SIZE      可选，默认 1024x1024（向接口请求的尺寸，各家支持的写法不同，
 *                      如通义万相用 1024*1024；1024x1024 是兼容面最广的一个）
 *  IMAGE_TARGET_SIZE   可选，默认 640 —— 落库前缩到的长边像素
 *  IMAGE_TARGET_QUALITY 可选，默认 70 —— JPEG 质量（40–95）
 *  IMAGE_API_ASYNC     可选，'1' 强制异步 / '0' 强制同步；不填时按 URL 自动判断
 *
 * 生图为什么必须异步（2026-09-28 定位，详见文档「七·补6」）：
 *  GLM-Image 单张生图 30–180 秒，而云函数执行超时上限远小于此 ⇒ 同步 await 会被**强杀**，
 *  已写入的 pending 没人再改，记录变成永远好不了的「僵尸」，表现为「等 6 分钟也没图、
 *  退出重进也没用」（实测卡 364 秒）。
 *  ⇒ generate 只提交任务并落库 taskId 后立即返回；真正的收图由 resolve({collect:true}) 驱动，
 *    每一次调用都在超时预算内。异步端点由 IMAGE_API_URL 自动推导，不用改环境变量。
 *
 * 落库前一律压缩：设计文档 07 节要求单图 40–80KB，直接存 1024 PNG 约 1–2MB，
 * 会白白吃掉云开发 2GB 共享容量。压缩用纯 JS 的 jimp，失败则原样保存不阻断。
 *
 * 关于「图片怎么送到前端」（重要，2026-09-26 踩过）：
 *  本环境云存储权限被锁死为「仅创建者可读写」（免费套餐下控制台改权限会提示「请升级至付费版」）。
 *  配图是云函数上传的，客户端不是「创建者」⇒ 把 cloud:// 直接填进 image 的 src 会被拒，
 *  表现为图区空白 + wx.previewImage 一直转圈。
 *  ⇒ 因此所有出参统一用管理员身份换成 https 临时链接（见 toTempUrls），前端只用 https。
 *  私有读的临时链接**默认只有 10 分钟**；toTempUrls 里显式申请了 6 小时有效期，
 *  前端仍按自己的 TTL 保守过期（见 miniprogram/utils/imageStore.js）。
 */

function postJson(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(new Error('IMAGE_API_URL 不是合法 URL'));
    }
    const mod = url.protocol === 'http:' ? http : https;
    const payload = JSON.stringify(body);
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          headers
        ),
        timeout: 120000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {
            /* 保留原始 text 供报错 */
          }
          if (res.statusCode >= 200 && res.statusCode < 300 && json) {
            resolve(json);
          } else {
            reject(new Error('生图接口返回 ' + res.statusCode + '：' + text.slice(0, 300)));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('生图接口请求超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** GET 一个 JSON 接口（查异步任务结果用） */
function getJson(urlStr, headers) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(new Error('结果查询 URL 不合法'));
    }
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.get(url, { headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          /* 保留原始 text 供报错 */
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && json) {
          resolve(json);
        } else {
          reject(new Error('结果查询返回 ' + res.statusCode + '：' + text.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('结果查询超时')));
  });
}

/**
 * 由同步端点推导智谱的异步端点（用户不用改环境变量）。
 *
 * 为什么必须异步：GLM-Image 单张生图 30–180 秒（官方与社区一致），
 * 而云函数执行超时上限远小于此 —— 同步 await 会被**强杀**，
 * 结果就是数据库里那条记录永远停在 pending（既不 ready 也不 failed）。
 * 异步接口提交后秒回，结果按 task id 轮询，每次调用都在超时预算内。
 *
 * 同步：https://open.bigmodel.cn/api/paas/v4/images/generations
 * 提交：https://open.bigmodel.cn/api/paas/v4/async/images/generations   → { id, task_status }
 * 查询：https://open.bigmodel.cn/api/paas/v4/async-result/{id}          → { task_status, image_result }
 */
function deriveAsyncEndpoints(apiUrl) {
  try {
    new URL(apiUrl);
  } catch (e) {
    return { submit: '', resultPrefix: '', err: 'IMAGE_API_URL 不是合法 URL' };
  }
  let submit = apiUrl;
  if (submit.indexOf('/async/images/generations') < 0) {
    submit = submit.replace('/images/generations', '/async/images/generations');
  }
  const idx = apiUrl.indexOf('/api/paas/v4/');
  const resultPrefix =
    idx >= 0 ? apiUrl.slice(0, idx) + '/api/paas/v4/async-result/' : apiUrl.replace(/\/[^/]*$/, '') + '/async-result/';

  // 只有确认是智谱那套路径（/api/paas/v4/）才敢走异步：
  // 对陌生网关盲猜一个 async 路径去 POST，容易拿到 404 还白花一次调用。
  // IMAGE_API_ASYNC=1 可强制开启（第三方网关也支持异步时用），=0 强制回落同步。
  const override = process.env.IMAGE_API_ASYNC;
  let asyncCapable = idx >= 0 && submit.indexOf('/async/images/generations') >= 0;
  if (override === '1') asyncCapable = true;
  if (override === '0') asyncCapable = false;

  return { submit, resultPrefix, asyncCapable };
}

/**
 * 从异步任务结果里找图片。字段命名各家不一（image_result / data / images…），
 * 这里做兼容解析，拿到 url 或 b64_json 任一即可。
 */
function pickImageItem(r) {
  if (!r || typeof r !== 'object') return null;
  const lists = [r.image_result, r.image_results, r.data, r.result, r.images];
  for (let i = 0; i < lists.length; i++) {
    const l = lists[i];
    if (Array.isArray(l) && l.length) {
      const it = l[0];
      if (it && (it.url || it.b64_json || it.image_url)) {
        return { url: it.url || it.image_url || '', b64_json: it.b64_json || '' };
      }
    }
  }
  if (r.url || r.b64_json) return { url: r.url || '', b64_json: r.b64_json || '' };
  return null;
}

/** 下载外链图片（部分接口返回 url 而非 b64_json） */
function download(url) {
  return new Promise((resolve, reject) => {
    const mod = url.indexOf('http:') === 0 ? http : https;
    const req = mod.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('图片下载超时')));
  });
}

/**
 * 落库前压缩：缩到长边 IMAGE_TARGET_SIZE（默认 640）并重编码为 JPEG。
 * 设计文档要求 WebP / 640px / 40–80KB；云函数里用纯 JS 的 jimp 最稳（无原生编译依赖）。
 * 压缩失败不阻断——宁可存一张大图，也不能因为压缩失败就没有图。
 */
let Jimp = null;
/** 按需装配 jimp：只装裁剪涉及的 4 个子包（5.4MB / 31 包），不用完整 jimp（25.8MB / 60 包） */
function getJimp() {
  if (Jimp) return Jimp;
  // 注意：组装入口是 @jimp/custom，不是 @jimp/core（core 导出的是 Jimp 类本身）
  const configure = require('@jimp/custom').default;
  const jpeg = require('@jimp/jpeg');
  const png = require('@jimp/png');
  const resize = require('@jimp/plugin-resize');
  // 只需要「读 PNG/JPEG → 缩放 → 编码 JPEG」，不引 gif/bmp/tiff/字体等用不到的能力
  // 注：@jimp/plugin-resize 只提供 resize()，没有 scaleToFit()（那在另一个包），所以自己算尺寸
  Jimp = configure({ types: [jpeg, png], plugins: [resize] });
  return Jimp;
}

async function compressForStorage(buffer) {
  const target = Math.max(128, Number(process.env.IMAGE_TARGET_SIZE || 640));
  const quality = Math.min(95, Math.max(40, Number(process.env.IMAGE_TARGET_QUALITY || 70)));
  try {
    const J = getJimp();
    const img = await J.read(buffer);
    const { width, height } = img.bitmap;
    // 长边缩到 target，短边等比；已比 target 小的图不放大
    const scale = Math.min(target / width, target / height, 1);
    if (scale < 1) {
      img.resize(Math.round(width * scale), Math.round(height * scale));
    }
    img.quality(quality);
    const out = await img.getBufferAsync(J.MIME_JPEG);
    // 纯色/简单图转成 JPEG 反而更大，这种就别压了，直接用原图
    if (out.length >= buffer.length) return { buffer: buffer, ext: detectExt(buffer) };
    return { buffer: out, ext: 'jpg' };
  } catch (e) {
    console.warn('[dishImage] compress skipped, keep original:', e && e.message);
    return { buffer: buffer, ext: detectExt(buffer) };
  }
}

/**
 * 把菜名转成云存储允许的 cloudPath 文件名（2026-09-27 踩坑，是「图区空白 403」的真根因）。
 *
 * 官方文档（CloudBase 云存储 uploadFile）对 cloudPath 的规定：
 *   「不能包含除 [0-9 , a-z , A-Z]、/、!、-、_、.、* 和**中文**以外的字符」
 *
 * 之前用的是 encodeURIComponent(菜名)，把「葱香肉松蛋卷」变成 %E8%91%B1%E9%A6%99…，
 * 其中的 **% 是非法字符**。结果文件能上传成功、fileID 也落了库，
 * 但私有读桶取不出来（对不存在/取不到的对象返回 403 而不是 404）⇒ 图区空白。
 *
 * 正确做法：中文本身是允许的，**不需要编码**，只需剔除真正非法的字符（% # ? & 空格等）。
 * 同时用 8 位时间戳 + 短随机串保证同名菜重生成不互相覆盖。
 */
function safeCloudPath(key, ext) {
  const base = String(key || '')
    // 先去掉 % 及其后可能残留的转义序列，再剔除其余非法字符
    .replace(/%[0-9A-Fa-f]{0,2}/g, '')
    .replace(/[^0-9A-Za-z\u4e00-\u9fa5!\-_.*]/g, '')
    .slice(0, 60);
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return 'dish-images/' + (base || 'dish') + '-' + stamp + '.' + (ext || 'jpg');
}

/** 按文件头判断原始格式，兜底为 png */
function detectExt(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
  return 'png';
}

/**
 * fileID → https 临时链接（批量）。
 *
 * 云函数是管理员身份，能换出带签名的链接给客户端用；客户端自己调会被权限拒绝。
 * 注意：接口一次最多 50 个 fileID，超出必须分批，否则报错。
 *
 * ⚠️ 必须传 { fileID, maxAge } 对象，不能传裸字符串（2026-09-27 踩坑，是「图区空白」的真根因）：
 *   - 官方文档：公有读文件的链接不过期，**私有读文件的链接十分钟有效期**。
 *     本环境权限被锁死为「仅创建者可读写」⇒ 属于私有读 ⇒ 10 分钟就失效。
 *   - 关键：`maxAge` 只在传**对象**时才会被带上。传裸字符串时 SDK 只上送 { fileid }，
 *     不带 max_age，服务端就按默认 600 秒签发。SDK 自己的 downloadFile 传的就是 maxAge: 600。
 *   - 现象：链接 10 分钟就死，而前端按 30 分钟判过期 ⇒ 中间 20 分钟一直在用死链接，
 *     表现为图区空白 + 点大图一直转圈，且退出重进页面也恢复不了。
 *   ⇒ 这里显式申请 6 小时（远大于前端 TTL），把「签发有效期」这条不再当瓶颈。
 */
const TEMP_URL_MAX_AGE_S = Math.max(600, Number(process.env.IMAGE_URL_MAX_AGE || 6 * 3600));

async function toTempUrls(fileIDs) {
  const list = (fileIDs || []).filter(Boolean);
  const map = {};
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    try {
      const res = await cloud.getTempFileURL({
        // 传对象才能带上 maxAge；传裸字符串会被服务端按默认 600 秒签发
        fileList: chunk.map((fileID) => ({ fileID, maxAge: TEMP_URL_MAX_AGE_S })),
      });
      (res && res.fileList ? res.fileList : []).forEach((f) => {
        // 官方约定：status 0 = 成功，errMsg = 'ok'；链接为空时说明该文件换不到，别写进 map
        if (f && f.fileID && f.tempFileURL) {
          map[f.fileID] = f.tempFileURL;
        } else if (f && f.fileID) {
          console.warn(
            '[dishImage] getTempFileURL 未返回链接 fileID=' + f.fileID +
              ' status=' + (f && f.status) + ' errMsg=' + (f && f.errMsg)
          );
        }
      });
    } catch (e) {
      console.warn('[dishImage] getTempFileURL failed:', e && e.message);
    }
  }
  return map;
}

/** { keys: [...] } → { map: { 菜名: https临时链接 }, missing: [...] }，批量给周视图/日视图用 */
async function resolve(event) {
  const raw = Array.isArray(event.keys) ? event.keys : [];
  const uniq = [];
  const seen = {};
  raw.forEach((k) => {
    const key = String(k || '').trim();
    if (key && !seen[key]) {
      seen[key] = true;
      uniq.push(key);
    }
  });
  if (!uniq.length) return { ok: true, map: {}, missing: [] };

  const res = await db
    .collection('dishImages')
    .where({ _id: _.in(uniq.slice(0, 100)) })
    .limit(100)
    .get();

  const files = {}; // 菜名 -> fileID（原始，备排查用）
  const docs = {};
  res.data.forEach((doc) => {
    docs[doc._id] = doc;
    if (doc.fileID) files[doc._id] = doc.fileID;
  });

  // collect=true：轮询场景下顺手收一次异步任务结果。
  // 为什么放在这里：生图 30–180 秒，超过云函数超时上限，不能在 generate 里傻等；
  // 而前端本来就在轮询 resolve，让它每次顺带问一句「好了没」，一次调用几秒就回来。
  // 周视图批量拉取不传 collect，保持快。
  const states = {};
  if (event.collect) {
    for (let i = 0; i < uniq.length; i++) {
      const doc = docs[uniq[i]];
      if (!doc || doc.fileID || !doc.taskId || doc.status === 'saving') {
        if (doc) states[uniq[i]] = doc.status || 'none';
        continue;
      }
      // 僵尸任务（超过 TASK_TTL 还没结果）不再白查，标记为可重提交。
      // ★ 判定必须用 ageOf 而不是 Date.now() - toMs()：pendingAt 一旦取不到，
      //   差值会变成 56.8 年，刚提交的任务也会被判超时（详见 ageOf 注释）。
      const pendingAge = ageOf(doc.pendingAt);
      if (doc.status === 'pending' && pendingAge > TASK_TTL_MS) {
        states[uniq[i]] = 'expired';
        // ★ 必须顺手把库里的状态推进，否则这道菜永远出不了图：
        //   status 一直停在 pending ⇒ claimSlot 的 where(status != 'pending') 永远匹配不到
        //   ⇒ 用户再点多少次都只会收到「已在生成中」，然后又被判超时，死循环。
        //   taskId 保留着不删，方便事后排查这个任务到底怎么了。
        await markDoc(uniq[i], {
          status: 'failed',
          lastError: '任务超时：等待超过 ' + TASK_TTL_MS / 60000 + ' 分钟仍未出图（taskId=' + doc.taskId + '）',
          failedAt: new Date(),
          failCount: (doc.failCount || 0) + 1,
        });
        continue;
      }
      // 历史记录里 pendingAt 被整体覆盖抹掉过（见 markDoc 注释）：补一次基准时间，
      // 让「已等待多久」重新可算。补上之后上面的超时判定才会正常工作。
      if (doc.status === 'pending' && doc.taskId && pendingAge < 0) {
        await markDoc(uniq[i], { pendingAt: new Date() });
      }
      const got = await tryCollect(doc); // 串行：避免并发重复上传同一张图
      if (got) files[uniq[i]] = got;
      states[uniq[i]] = got ? 'ready' : (docs[uniq[i]] && docs[uniq[i]].status) || doc.status;
    }
  } else {
    uniq.forEach((k) => {
      if (docs[k]) states[k] = docs[k].status || 'none';
    });
  }

  // 客户端读不了私有文件，统一换成 https 临时链接再返回
  const urls = await toTempUrls(Object.keys(files).map((k) => files[k]));
  const map = {}; // 菜名 -> https 临时链接（前端直接用于 image / previewImage）
  Object.keys(files).forEach((k) => {
    if (urls[files[k]]) map[k] = urls[files[k]];
  });
  if (Object.keys(files).length && !Object.keys(map).length) {
    console.warn('[dishImage] resolve 有 fileID 但临时链接全部换取失败，检查云存储文件是否存在');
  }

  return { ok: true, map, files, states, missing: uniq.filter((k) => !files[k]) };
}

/**
 * 异步任务的复用窗口：这段时间内同一个 key 重复点「生成」直接复用任务，不重复提交
 * （重复提交＝重复扣费）。10 分钟覆盖官方给出的 30–180 秒上限并留足余量。
 *
 * 注意：这个窗口只对「带 taskId 的异步任务」生效。旧同步模式留下的 pending 没有 taskId，
 * 那是被强杀的僵尸记录，必须允许立刻重新提交（见 generate 的陈旧判定）。
 */
const TASK_TTL_MS = 10 * 60 * 1000;
/** 「正在收图」中间态的锁定时长：防止多个并发请求重复下载+上传 */
const SAVING_LOCK_MS = 2 * 60 * 1000;
/** 连续失败冷却：接口异常时不反复烧钱 */
const FAIL_COOLDOWN_MS = 2 * 60 * 1000;
const FAIL_COOLDOWN_THRESHOLD = 3;

/** Date / ISO 字符串 / 时间戳 → 毫秒，取不到就返回 0 */
function toMs(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

/**
 * 距今多久（毫秒）；时间字段缺失时返回 **-1**，表示「不知道」。
 *
 * ★ 为什么不能像 toMs 那样缺失就返回 0（2026-09-30 实踩）：
 *   toMs 返回 0 的话，`Date.now() - 0` ≈ 1.79e12 毫秒 ≈ **56.8 年**，
 *   跟任何 TTL 比都是「早就超了」⇒ 刚提交的任务被瞬间判成超时。
 *   缺失是「不知道」，不是「很久以前」，这两件事必须分开。
 *   调用方统一用 `age >= 0 && age < TTL` 的写法：只有确知时间才做时间判定。
 */
function ageOf(v) {
  const ms = toMs(v);
  return ms > 0 ? Date.now() - ms : -1;
}

/** 读一条配图记录；不存在时 db 会抛错，统一按「没有」处理 */
async function readDoc(key) {
  try {
    const res = await db.collection('dishImages').doc(key).get();
    return (res && res.data) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 写状态标记（pending / ready / failed）。写失败不能阻断主流程
 *
 * ★★ 必须走 update（局部更新），绝不能用 set（2026-09-30 实踩，血的教训）：
 *    看 SDK 源码就很直白（@cloudbase/database/dist/commonjs/document.js）：
 *      set()    → merge: false, upsert: true    ← 整体覆盖，没传的字段直接抹掉
 *      update() → merge: true,  upsert: false   ← 局部更新
 *    原来这里用 set，结果 generate 提交成功后补写 taskId 那一下，
 *    把记录里已有的 pendingAt / submitCount 全抹没了：
 *      · pendingAt 没了 ⇒ 超时判定算出「56.8 年前提交的任务」（Date.now() - 0）
 *        ⇒ 刚点下去就被判成 expired，前端直接弹「任务超时了，请再点一次」
 *      · submitCount 没了 ⇒ 配图管理页永远显示「提交 0 次」，花了多少钱查不出来
 *
 *    update 对不存在的记录不会创建（upsert: false，返回 updated: 0），
 *    所以拿不到更新条数时退回 set 去创建。
 */
async function markDoc(key, data) {
  const payload = Object.assign({ updatedAt: db.serverDate() }, data);
  try {
    const res = await db.collection('dishImages').doc(key).update({ data: payload });
    const n = res && typeof res.updated === 'number' ? res.updated : res && res.stats && res.stats.updated;
    if (n === 0) throw new Error('记录不存在，退回 set 创建');
    return;
  } catch (e) {
    // 记录还不存在（第一次写），或 update 报错 —— 用 set 创建
    try {
      await db.collection('dishImages').doc(key).set({ data: payload });
    } catch (e2) {
      console.warn('[dishImage] markDoc failed:', (e2 && e2.message) || (e && e.message));
    }
  }
}

/**
 * 生图失败是不是「配额/钱」这一类。
 *
 * 为什么要单列：这一类占了日常失败的大头，而它的处理动作与其它错误完全不同 ——
 * 401/404 是配置错了（改环境变量 + 重新部署），配额耗尽是去服务商后台充钱（改不了也不该改代码）。
 * 混着报会让人对着代码查半天，2026-09-30 就是这么绕了一轮才看清。
 *
 * 匹配口径放宽一点：各家的说法有差别，但「429 + 余额不足 / 无可用资源包 / quota」基本共通。
 * 宁可多命中一次，也不要让这类错误掉进「未知原因」。
 *
 * @param {string} msg lastError 原文
 * @returns {boolean}
 */
function isQuotaError(msg) {
  const s = String(msg || '');
  if (!s) return false;
  const chronic = ['余额不足', '无可用资源包', '额度不足', '已用尽', '已到期', '资源包已过期'];
  if (chronic.some((w) => s.indexOf(w) >= 0)) return true;
  return /429/.test(s) && /quota|insufficient|balance/i.test(s);
}

/**
 * 生图提示词：统一在这里，异步/同步两条路共用。
 *
 * 2026-09-30 调整：菜名之外补进做法要点。
 * 起因是「贝贝南瓜发糕」这类名字，模型并不知道成品长什么样（是馒头状？切块？撒了什么？），
 * 只给名字会生成一个凭空的糕点，和用户实际吃到的差很远。
 * 做法里恰好含「蒸 / 煎 / 烤」与主要食材，抽出关键词就能把形态与色泽钉住。
 *
 * 2026-10-07 调整：写实美食摄影 → 极简矢量几何插画。
 * 用户指定风格：扁平矢量 + 色块平涂 + 简约构图 + 主体食物夸张几何变形 + 无阴影无渐变 +
 * 清晰硬边 + 纯色背景 + 干净单线轮廓，干净高级、像美食 App 图标 / 极简海报。
 * 配色沿用 UI 2.0 四色（品牌紫 / 柠檬黄绿 / 薄荷绿 / 墨绿）做点缀，纯色米白或淡紫底。
 * 颜色用中文名而不是色号——多数生图模型对 hex 的响应不稳定。
 * 禁字从「无文字」升级为「严禁出现任何文字/字母/数字/水印/标志」——只写「无文字」挡不住模型烧大字。
 *
 * @param {string} title 菜名
 * @param {string} [recipe] 做法（可选；前端从 day 页带过来，可能为空）
 */
function buildPrompt(title, recipe) {
  const tail =
    '极简矢量几何风食物插画，扁平矢量，色块平涂，无渐变、无模糊柔和阴影，清晰硬边与单线轮廓，无多余纹理，简约构图。' +
    '主体食物做夸张几何变形，大色块平涂。纯色背景（米白或淡紫），点缀品牌紫、柠檬黄绿、薄荷绿、墨绿，低饱和度、干净高级，像美食 App 图标 / 极简海报。' +
    '画面中严禁出现任何文字、汉字、字母、数字、符号、水印、标志或标签；这是一张不含任何文字的纯图片，只呈现食物插画本身，不要添加任何说明性文字。8K。';

  const kw = extractRecipeKeywords(recipe);
  if (!kw.length) {
    return '一道家常辅食的极简矢量插画：「' + title + '」，画成夸张变形的几何色块。' + tail;
  }

  return (
    '一道家常辅食的极简矢量插画：「' + title + '」。做法要点：' + kw.join('、') +
    '。据此把食物画成对应形态与色泽的夸张几何色块。' + tail
  );
}

/** 做法里能帮模型「定型」的线索词。命中即带上，改写不了语义但能锁住形态/色泽 */
const RECIPE_HINTS = [
  '蒸', '煎', '烤', '煮', '炖', '炸', '焯', '炒', '焖', '拌', '发酵', '醒发',
  '南瓜', '山药', '苹果', '红枣', '紫薯', '红薯', '土豆', '玉米', '胡萝卜', '西兰花',
  '鸡蛋', '牛奶', '酸奶', '面粉', '米粉', '糯米', '燕麦', '奶酪', '肉松', '虾仁', '牛肉', '鸡肉', '鱼肉',
  '卷', '饼', '糕', '粥', '羹', '汤', '丸', '条', '丝', '块', '泥', '糊',
];

/**
 * 从做法文本里抽提示词线索。
 * 有意做得很轻：不解析句子、不保留数量与克数（对画面无意义，还会挤占提示词预算）。
 * 做法为空或抽不出任何词时返回 []，调用方退回纯菜名提示词。
 *
 * @param {string} recipe
 * @returns {string[]} 去重后的关键词，最多 8 个
 */
function extractRecipeKeywords(recipe) {
  const text = String(recipe || '');
  if (!text.trim()) return [];
  const hit = [];
  RECIPE_HINTS.forEach((w) => {
    if (text.indexOf(w) >= 0 && hit.indexOf(w) < 0) hit.push(w);
  });
  return hit.slice(0, 8);
}

/**
 * 抢占「提交位」——同一道菜同一时刻只允许一个请求真的去叫服务商。
 *
 * 为什么需要它（2026-09-30 用户实踩）：
 *   原来的保护是「读一下 doc，看到 pending 就返回」，这是典型的 **check-then-act**：
 *   两个请求同时进来，都读到「还没 pending」，就都去提交了 ⇒ 同一道菜扣两次钱。
 *   用户端的实际触发路径：点了生成 → 退出页面 → 再进来没提示 → 又点了一次。
 *
 *   注意这里说的「并发」不一定是同一毫秒：前端在 generating 状态被重置后再点、
 *   云函数冷启动重入、弱网重试，都会造成两次调用交错。
 *
 * 做法：把「占位」变成**一次带条件的原子写**，谁写成功谁才有权调用付费接口。
 *   · 记录不存在 → 用 add({_id:key}) 抢占（同 _id 重复 add 会失败 ⇒ 后来者抢不到）
 *   · 记录已存在 → 用 where(status != 'pending') 条件更新抢占（正在跑的那个是 pending ⇒ 抢不到）
 * 这样即使两个调用完全并发，也只有一个能越过这道坎。
 *
 * @param {string} key 归一化菜名
 * @param {object} fields 落库字段（title 等）
 * @param {boolean} incSubmit 是否累加提交计数（真正要去花钱时才传 true）
 * @returns {Promise<{ok: boolean, reason: string}>} ok=true 表示抢到了、可以去提交
 */
async function claimSlot(key, fields, incSubmit) {
  const base = Object.assign(
    { title: (fields && fields.title) || key, updatedAt: db.serverDate() },
    fields || {}
  );
  try {
    // 先试「新建」：只有原本没有这条记录时才成功
    const created = await db.collection('dishImages').add({
      data: Object.assign({}, base, {
        _id: key,
        status: 'pending',
        pendingAt: new Date(),
        taskId: '',
        submitCount: incSubmit ? 1 : 0,
        failCount: 0,
      }),
    });
    if (created && created._id) return { ok: true, reason: 'created' };
    return { ok: false, reason: 'add-returned-no-id' };
  } catch (e) {
    // 多半是重复 key（记录已存在），继续走条件更新这条路
  }

  try {
    const upd = Object.assign({}, base, {
      status: 'pending',
      pendingAt: new Date(),
      taskId: '',
    });
    if (incSubmit) upd.submitCount = _.inc(1);
    const res = await db
      .collection('dishImages')
      .where({ _id: key, status: _.neq('pending') })
      .update({ data: upd });
    const n = res && res.stats ? res.stats.updated : 0;
    return n > 0 ? { ok: true, reason: 'updated' } : { ok: false, reason: 'busy' };
  } catch (e) {
    // 条件更新失败（权限/集合异常）时**放行**：宁可偶尔重复一次，也不要整个功能不可用。
    // 但必须打日志，事后能从这里核对有没有真的重复。
    console.warn('[dishImage] claimSlot 条件更新失败，放行：', e && e.message);
    return { ok: true, reason: 'claim-failed-open' };
  }
}

/** 把「下载 → 压缩 → 上传云存储 → 落库 ready」这一段收尾流程抽出来，异步/同步共用 */
async function finishAndStore(ctx, raw, extra) {
  const key = ctx.key;
  const packed = await compressForStorage(raw);
  // 注意：不能用 encodeURIComponent(菜名)——% 是 cloudPath 非法字符，会让文件取不出来（403）。
  // safeCloudPath 保留中文（官方允许）并剔除非法字符，详见其注释。
  const cloudPath = safeCloudPath(key, packed.ext);
  const up = await cloud.uploadFile({ cloudPath, fileContent: packed.buffer });
  const fileID = up.fileID;

  await markDoc(
    key,
    Object.assign(
      {
        fileID,
        title: ctx.title,
        prompt: ctx.prompt,
        source: 'ai',
        model: ctx.model,
        requestSize: ctx.size,
        bytes: packed.buffer.length,
        rawBytes: raw.length,
        status: 'ready',
        generatedAt: db.serverDate(),
        taskId: ctx.taskId || '',
      },
      extra || {}
    )
  );
  return { fileID, bytes: packed.buffer.length, rawBytes: raw.length };
}

/**
 * 前置检查：归一化参数 → 幂等判定 → 环境变量校验。
 * 返回里 ok=false / pending / cached 都表示「可以就此返回」，否则带着后续流程要的一切继续。
 */
async function prepare(event) {
  const key = String(event.key || '').trim();
  const title = String(event.title || '').trim() || key;
  if (!key) return { ok: false, message: '缺少 key（归一化菜名）' };

  // 幂等保护：成品直接复用；生成中/冷却期直接返回，不重复计费。
  // force=true 表示用户明确点了「换一张配图」，此时要真的重生成（否则按钮永远换不了图）。
  // 注意：任务窗口对 force 依然生效 —— 连点两下仍会被挡住，不会重复扣费。
  const force = !!event.force;
  const prev = await readDoc(key);
  if (prev) {
    if (prev.fileID && !force) {
      const cachedUrls = await toTempUrls([prev.fileID]);
      return {
        ok: true,
        key,
        fileID: prev.fileID,
        url: cachedUrls[prev.fileID] || '',
        cached: true,
        bytes: prev.bytes,
        rawBytes: prev.rawBytes,
      };
    }
    // pending 必须分两种，混在一起就会永远卡死：
    //  - 带 taskId：异步任务在跑，窗口内复用即可（不重复提交＝不重复扣费）
    //  - 不带 taskId：旧同步模式留下的**僵尸记录**（云函数在 await 生图时被强杀，
    //    既不写 ready 也不写 failed）⇒ 必须允许立刻重新提交，否则这道菜永远出不了图。
    // pendingAge = -1 表示库里没有 pendingAt（历史记录被整体覆盖抹掉过）。
    // 这时**不复用**：不知道等了多久，就当已经过期，允许重新提交（配合下面的原子锁，不会重复扣费）。
    const pendingAge = ageOf(prev.pendingAt);
    if (prev.status === 'pending' && prev.taskId && pendingAge >= 0 && pendingAge < TASK_TTL_MS) {
      return {
        ok: true,
        key,
        pending: true,
        taskId: prev.taskId,
        message: '任务还在生成中（已提交 ' + Math.round(pendingAge / 1000) + ' 秒）',
      };
    }
    const savingAge = ageOf(prev.savingAt);
    if (prev.status === 'saving' && savingAge >= 0 && savingAge < SAVING_LOCK_MS) {
      return { ok: true, key, pending: true, message: '图已生成，正在入库' };
    }
    const failAge = ageOf(prev.failedAt);
    if (
      prev.status === 'failed' &&
      (prev.failCount || 0) >= FAIL_COOLDOWN_THRESHOLD &&
      failAge >= 0 &&
      failAge < FAIL_COOLDOWN_MS
    ) {
      const wait = Math.ceil((FAIL_COOLDOWN_MS - failAge) / 1000);
      return {
        ok: false,
        key,
        code: 'COOLDOWN',
        message: '连续生成失败，已暂停 ' + wait + ' 秒以免继续消耗额度，请稍后再试',
      };
    }
  }

  const apiUrl = process.env.IMAGE_API_URL;
  const apiKey = process.env.IMAGE_API_KEY;
  const model = process.env.IMAGE_API_MODEL || 'gpt-image-1';
  if (!apiUrl || !apiKey) {
    return {
      ok: false,
      code: 'NOT_CONFIGURED',
      message:
        '未配置生图服务：请在本云函数的环境变量中设置 IMAGE_API_URL 与 IMAGE_API_KEY（OpenAI 兼容 images/generations 接口）',
    };
  }

  return {
    ok: true,
    key,
    title,
    force,
    prev,
    apiUrl,
    apiKey,
    model,
    size: process.env.IMAGE_API_SIZE || '1024x1024',
    prompt: buildPrompt(title, event.recipe),
  };
}

/**
 * { key, title?, force? } → 提交生图任务，**立即返回**，不等图。
 *
 * 为什么不能同步等（2026-09-28 定位）：GLM-Image 单张生图 30–180 秒，
 * 而云函数执行超时上限远小于此 ⇒ 函数在 await 生图时被强杀 ⇒ 数据库记录永远停在 pending
 * （既不 ready 也不 failed，表现为「点生成后一直转圈，退出重进也永远没有图」）。
 * 实测就卡了 364 秒不动。
 *
 * 异步模式：这里只提交任务（秒回），把 taskId 落库；
 * 真正的收图由 resolve(collect:true) 在前端轮询时驱动，每次调用都在超时预算内。
 * 若服务商不支持异步（提交拿不到 task id），自动回落到同步。
 */
async function generate(event) {
  const ctx = await prepare(event);
  if (!ctx.ok || ctx.pending || ctx.cached) return ctx;

  // ★ 原子抢占提交位：抢不到说明已经有同伴在为这道菜生图了，
  //   直接返回「进行中」让前端继续轮询 —— 绝不重复调用付费接口。
  //   （prepare 里那段 pending 判断是「读后木ように発生する」的检查，拦不住并发；这里才是有锁的那道。）
  const claimed = await claimSlot(ctx.key, { title: ctx.title, asyncMode: true }, true);
  if (!claimed.ok) {
    const cur = await readDoc(ctx.key);
    console.log(
      '[dishImage] generate skipped, someone else is generating:',
      ctx.key,
      'reason=' + claimed.reason,
      'existingTaskId=' + ((cur && cur.taskId) || '(none)')
    );
    return {
      ok: true,
      key: ctx.key,
      pending: true,
      taskId: (cur && cur.taskId) || '',
      reused: true,
      message: '这道菜已经在生成中了，稍等即可，不会重复消耗次数',
    };
  }

  const ep = deriveAsyncEndpoints(ctx.apiUrl);
  if (ep.asyncCapable) {
    try {
      const sub = await postJson(
        ep.submit,
        { Authorization: 'Bearer ' + ctx.apiKey },
        { model: ctx.model, prompt: ctx.prompt, size: ctx.size }
      );
      const taskId = sub && sub.id;
      if (!taskId) throw new Error('异步提交未返回任务 id：' + JSON.stringify(sub).slice(0, 200));

      await markDoc(ctx.key, {
        title: ctx.title,
        status: 'pending',
        taskId,
        asyncMode: true,
        failCount: (ctx.prev && ctx.prev.failCount) || 0,
      });
      // 计数在 claimSlot 里用 _.inc 原子累加过了，这里不再动，避免覆盖
      console.log(
        '[dishImage] async task submitted',
        ctx.key,
        'taskId=' + taskId,
        'submitCount=' + ((ctx.prev && ctx.prev.submitCount) || 0) + '→' +
          (((ctx.prev && ctx.prev.submitCount) || 0) + 1)
      );
      return {
        ok: true,
        key: ctx.key,
        pending: true,
        taskId,
        asyncMode: true,
        message: '已提交生成任务，通常 30～180 秒出图',
      };
    } catch (e) {
      // 提交失败就回落同步，别让异步假设把功能彻底堵死
      console.warn('[dishImage] 异步提交失败，回落同步：', e && e.message);
    }
  }

  return await generateSync(ctx);
}

/** 同步兜底：服务商不支持异步时走原路径（等图 → 落库 → 返回） */
async function generateSync(ctx) {
  const key = ctx.key;
  // 注意：不再重写 pendingAt —— 提交位已在 generate 里原子抢占并写了时间，
  // 这里再写一次会把「已等待多久」清零，前端的等待时长就会显示得不对。
  await markDoc(key, {
    title: ctx.title,
    status: 'pending',
    taskId: '',
    asyncMode: false,
    failCount: (ctx.prev && ctx.prev.failCount) || 0,
  });

  const t0 = Date.now();
  console.log('[dishImage] generate start(sync)', key, 'model=' + ctx.model, 'size=' + ctx.size);

  try {
    const apiRes = await postJson(
      ctx.apiUrl,
      { Authorization: 'Bearer ' + ctx.apiKey },
      { model: ctx.model, prompt: ctx.prompt, n: 1, size: ctx.size }
    );

    const item = apiRes && apiRes.data && apiRes.data[0];
    if (!item) throw new Error('生图接口未返回图片数据');

    let raw;
    if (item.b64_json) {
      raw = Buffer.from(item.b64_json, 'base64');
    } else if (item.url) {
      // 接口给外链时中转下载再入云存储，避免外链过期（智谱的链接 30 天失效）
      raw = await download(item.url);
    } else {
      throw new Error('生图接口返回格式无法识别');
    }

    const saved = await finishAndStore(ctx, raw, {
      // 智谱返回的 content_filter 自带安全判定，落库备查（P-1 内容安全）
      contentFilter: apiRes.content_filter || null,
    });

    console.log(
      '[dishImage] generate done',
      key,
      Date.now() - t0 + 'ms',
      'bytes=' + saved.bytes,
      'rawBytes=' + saved.rawBytes
    );

    return {
      ok: true,
      key,
      fileID: saved.fileID,
      url: (await toTempUrls([saved.fileID]))[saved.fileID] || '',
      bytes: saved.bytes,
      rawBytes: saved.rawBytes,
      genMs: Date.now() - t0,
    };
  } catch (e) {
    const msg = (e && e.message) || '生图失败';
    console.error('[dishImage] generate failed', key, Date.now() - t0 + 'ms', msg);
    await markDoc(key, {
      title: ctx.title,
      status: 'failed',
      // 配额类失败**不累加失败计数**：它在服务商那里就被拒了，一分钱没花、也没占额度，
      // 计入冷却毫无收益；反而是个坑 —— 用户充完钱立刻点会被「已暂停 XX 秒」挡住，
      // 看着像系统在为难他。所以沿用旧的 failedAt，让 cooldown 永远不因为配额触发。
      failCount: isQuotaError(msg)
        ? (ctx.prev && ctx.prev.failCount) || 0
        : ((ctx.prev && ctx.prev.failCount) || 0) + 1,
      lastError: String(msg).slice(0, 300),
      failedAt: isQuotaError(msg)
        ? (ctx.prev && ctx.prev.failedAt) || ''
        : new Date(),
      // 保留上一次成功的图，避免失败后连旧图也丢了
      fileID: (ctx.prev && ctx.prev.fileID) || '',
    });
    return { ok: false, key, code: 'GENERATE_FAILED', message: msg, genMs: Date.now() - t0 };
  }
}

/** 收图：查一次异步任务结果，SUCCESS 就下载+压缩+上传+落库 ready。返回 fileID 或 '' */
async function tryCollect(doc) {
  const key = doc._id;
  const taskId = doc.taskId;
  const apiKey = process.env.IMAGE_API_KEY;
  const ep = deriveAsyncEndpoints(process.env.IMAGE_API_URL);
  if (!taskId || !apiKey || !ep.resultPrefix) return '';

  let r;
  try {
    r = await getJson(ep.resultPrefix + encodeURIComponent(taskId), {
      Authorization: 'Bearer ' + apiKey,
    });
  } catch (e) {
    console.warn('[dishImage] async-result 查询失败', key, e && e.message);
    return '';
  }

  const st = r && r.task_status;
  if (st === 'SUCCESS') {
    // 抢锁：并发轮询时只让一个实例去做「下载+上传」，避免重复入库
    await markDoc(key, { status: 'saving', savingAt: new Date() });
    try {
      const item = pickImageItem(r);
      if (!item) throw new Error('异步结果里没有图片数据：' + JSON.stringify(r).slice(0, 200));
      const raw = item.b64_json ? Buffer.from(item.b64_json, 'base64') : await download(item.url);
      const saved = await finishAndStore(
        {
          key,
          title: doc.title || key,
          prompt: doc.prompt || '',
          model: doc.model || process.env.IMAGE_API_MODEL || 'glm-image',
          size: doc.requestSize || process.env.IMAGE_API_SIZE || '1024x1024',
          taskId,
        },
        raw
      );
      console.log('[dishImage] async collected', key, 'taskId=' + taskId, 'bytes=' + saved.bytes);
      return saved.fileID;
    } catch (e) {
      console.error('[dishImage] 收图失败', key, e && e.message);
      // 同上：配额类失败不累加计数、不刷新 failedAt，避免充完钱被冷却挡住
      const quota = isQuotaError((e && e.message) || e);
      await markDoc(key, {
        status: 'failed',
        failCount: quota ? doc.failCount || 0 : (doc.failCount || 0) + 1,
        lastError: '收图失败：' + String((e && e.message) || e).slice(0, 300),
        failedAt: quota ? doc.failedAt || '' : new Date(),
        fileID: doc.fileID || '',
      });
      return '';
    }
  }

  if (st === 'FAIL') {
    console.warn('[dishImage] 生图任务失败', key, 'taskId=' + taskId);
    await markDoc(key, {
      status: 'failed',
      failCount: (doc.failCount || 0) + 1,
      lastError: '生图任务失败（服务商返回 FAIL）',
      failedAt: new Date(),
      fileID: doc.fileID || '',
    });
  }
  return ''; // PROCESSING：继续等
}

/**
 * diag —— 逐阶段自检，用于排查 generate 报 -3 Upstream error。
 * 每一「段」完成会先打 console.log 再往下走，即使进程中途被打死，
 * 云函数日志里也能看到最后一条 [diag] 标记，从而定位死在哪一段。
 */
async function diag(event) {
  const steps = [];
  const t0 = Date.now();
  const mb = () => Math.round(process.memoryUsage().rss / 1048576);
  const mark = function (name, extra) {
    const line = name + (extra ? ' :: ' + extra : '');
    console.log('[dishImage][diag] ' + line + ' (+' + (Date.now() - t0) + 'ms, rss=' + mb() + 'MB)');
    steps.push(line);
  };

  mark('start', 'NODE=' + process.version);

  // 1. 环境变量
  const apiUrl = process.env.IMAGE_API_URL;
  const apiKey = process.env.IMAGE_API_KEY;
  const model = process.env.IMAGE_API_MODEL || 'gpt-image-1';
  const masked = apiKey ? apiKey.slice(0, 6) + '...' + apiKey.slice(-4) + '(len=' + apiKey.length + ')' : '(empty)';
  mark('env', 'url=' + !!apiUrl + ' urlHost=' + (safeHost(apiUrl)) + ' key=' + masked + ' model=' + model);

  // 2. DNS + TCP 443 连通性（验证公网出口，不依赖业务代码）
  const host = safeHost(apiUrl);
  if (host) {
    await new Promise((done) => {
      const sock = net.connect(443, host, () => {
        mark('tcp-ok', host + ':443');
        sock.destroy();
        done();
      });
      sock.setTimeout(10000, () => {
        mark('tcp-timeout', host + ':443');
        sock.destroy();
        done();
      });
      sock.on('error', (e) => {
        mark('tcp-err', host + ' :: ' + e.message);
        done();
      });
    });
  }

  // 3. 真实生图请求（只计时、不落库）
  let genMs = -1;
  let genInfo = '';
  if (apiUrl && apiKey) {
    const t1 = Date.now();
    try {
      const apiRes = await postJson(
        apiUrl,
        { Authorization: 'Bearer ' + apiKey },
        {
          model,
          prompt: '一道家常辅食的极简矢量插画：「番茄炒蛋」，纯色米白背景，品牌紫与柠檬黄绿点缀，色块平涂无阴影，画面中严禁出现任何文字、汉字、字母、数字或符号，只呈现食物插画本身。',
          n: 1,
          size: process.env.IMAGE_API_SIZE || '1024x1024',
        }
      );
      genMs = Date.now() - t1;
      const item = apiRes && apiRes.data && apiRes.data[0];
      genInfo = item
        ? (item.b64_json ? 'b64=' + item.b64_json.length : '') + (item.url ? 'url=' + item.url.slice(0, 60) : '') +
          ' contentFilter=' + JSON.stringify(apiRes.content_filter || null)
        : 'no-data ' + JSON.stringify(apiRes).slice(0, 200);
      mark('gen-ok', genMs + 'ms ' + genInfo);
    } catch (e) {
      genMs = Date.now() - t1;
      mark('gen-err', genMs + 'ms ' + String(e && e.message).slice(0, 300));
    }
  } else {
    mark('gen-skip', '未配置，跳过');
  }

  // 4. 压缩依赖可用性
  try {
    require('@jimp/custom');
    mark('slim-jimp-ok');
  } catch (e1) {
    try {
      require('jimp');
      mark('legacy-jimp-ok', '(旧版依赖还在)');
    } catch (e2) {
      mark('jimp-missing', e1.message.slice(0, 80));
    }
  }

  mark('end', 'total=' + (Date.now() - t0) + 'ms');

  return {
    ok: true,
    diag: {
      steps: steps,
      totalMs: Date.now() - t0,
      genMs: genMs,
      rssMB: mb(),
      memoryLimitHint: '若 end 缺失且最后停在 gen-*，多半是内存/超时被打死',
    },
  };
}

function safeHost(urlStr) {
  try {
    return new URL(String(urlStr)).hostname;
  } catch (e) {
    return '';
  }
}

/** 配图库统计（我的页展示）。只数真正有图的，pending / failed 占位记录不算 */
async function stats() {
  const total = await db
    .collection('dishImages')
    .where({ fileID: _.exists(true) })
    .count();
  return { ok: true, total: total.total };
}

/**
 * selfcheck —— 「图为什么显示不出来」的一站式自检（一个 action 给出完整判断）。
 *
 * 为什么需要它：这个故障已经连续误判两轮（先猜生图失败、再猜存储权限、又猜链接有效期），
 * 每轮都要「改代码 → 部署 → 再看」。与其继续猜，不如让云函数自己把
 * 「文件在不在、链接能不能换出来、链接能不能真的下载」一次性验证完。
 *
 * 关键一步：**真的用 HTTPS GET 一次换出来的链接**，看状态码。
 *   200 ⇒ 链接可用，问题在前端渲染（域名白名单等）
 *   403 ⇒ 链接被拒 / 已过期
 *   404 ⇒ 文件路径不对
 * 这是唯一能把「服务端问题」和「小程序端问题」彻底分开的证据。
 *
 * @param {{ key?: string }} event 传 key 只看一道菜；不传则看最近有图的几条
 */
async function selfcheck(event, context) {
  const report = { steps: [], verdict: '', hints: [] };
  const push = (name, detail) => {
    report.steps.push({ name, detail });
    console.log('[dishImage][selfcheck] ' + name + ' :: ' + detail);
  };

  // 0. 部署版本指纹：用来确认「我改的代码到底有没有真的部署上去」
  const src = fs.readFileSync(__filename, 'utf8');
  const hasMaxAge = /maxAge:\s*TEMP_URL_MAX_AGE_S/.test(src);
  push(
    'code-version',
    'hasMaxAge=' + hasMaxAge + ' TEMP_URL_MAX_AGE_S=' + TEMP_URL_MAX_AGE_S +
      ' asyncMode=' + /async\/images\/generations/.test(src) +
      ' node=' + process.version
  );
  if (!hasMaxAge) {
    report.verdict = 'DEPLOYED_CODE_IS_OLD';
    report.hints.push('云端跑的还是旧代码：maxAge 修复不在里面。请重新「上传并部署：云端安装依赖」。');
    return { ok: true, report };
  }

  // 0.5 云函数的**实际超时配置** —— 判断「同步等生图会不会被强杀」的决定性证据。
  //     GLM-Image 生图 30–180 秒；若这里显示的 timeout 明显小于它，同步模式必死。
  const timeLimit =
    context && (context.time_limit_in_ms || context.time_limit || context.timeout);
  const memLimit = context && (context.memory_limit_in_mb || context.memoryLimitInMB);
  report.runtime = {
    timeLimitMs: typeof timeLimit === 'number' ? timeLimit : null,
    memoryMb: typeof memLimit === 'number' ? memLimit : null,
    remainingMs:
      context && typeof context.getRemainingTimeInMillis === 'function'
        ? context.getRemainingTimeInMillis()
        : null,
    contextKeys: context ? Object.keys(context).join(',') : '',
  };
  push(
    'runtime',
    'timeout=' + (report.runtime.timeLimitMs != null ? report.runtime.timeLimitMs + 'ms' : '(未暴露)') +
      ' memory=' + (report.runtime.memoryMb != null ? report.runtime.memoryMb + 'MB' : '(未暴露)') +
      ' remaining=' + (report.runtime.remainingMs != null ? report.runtime.remainingMs + 'ms' : '(未暴露)') +
      ' | 生图需 30–180s，若 timeout 明显更小则同步等待必被强杀'
  );

  // 1. 环境变量与生图链路配置
  const apiUrl = process.env.IMAGE_API_URL;
  push('env', 'IMAGE_API_URL=' + (apiUrl ? safeHost(apiUrl) : '(empty)') +
    ' IMAGE_API_KEY=' + (process.env.IMAGE_API_KEY ? '已配置' : '(empty)'));

  // 1.1 环境变量没配就没有生图链路，后面那些端点/任务检查都无从谈起。
  //     原先这里直接往下走，最后落到通用兜底「NEED_MANUAL_LOOK」，
  //     会把「压根没配置」说成「未命中已知结论」，误导排查方向。
  if (!apiUrl || !process.env.IMAGE_API_KEY) {
    report.verdict = 'NOT_CONFIGURED';
    report.hints.push(
      '★ 云函数没配生图服务：IMAGE_API_URL / IMAGE_API_KEY 至少缺一个，点「生成 AI 配图」必然失败。',
      '补配路径：微信开发者工具 → 云开发控制台 → 云函数 → dishImage → 配置 → 环境变量，',
      '加 IMAGE_API_URL（如 https://open.bigmodel.cn/api/paas/v4/images/generations）与 IMAGE_API_KEY，',
      '然后重新部署一次（改环境变量后建议顺手「上传并部署」让新配置生效）。'
    );
    return { ok: true, report };
  }

  // 1.5 异步端点推导结果：确认生图走的是异步（提交+取结果）而不是同步傻等
  if (apiUrl) {
    const ep = deriveAsyncEndpoints(apiUrl);
    report.async = { submit: ep.submit, resultPrefix: ep.resultPrefix, capable: !!ep.asyncCapable };
    push(
      'async-endpoints',
      'capable=' + !!ep.asyncCapable + ' submit=' + ep.submit + ' result=' + ep.resultPrefix + '{id}'
    );
  }

  // 2. 挑要检查的菜名
  let keys = [];
  if (event && event.key) {
    keys = [String(event.key).trim()];
  } else {
    const recent = await db
      .collection('dishImages')
      .where({ fileID: _.exists(true) })
      .limit(5)
      .get();
    keys = (recent.data || []).map((d) => d._id);
  }
  push('targets', keys.length ? keys.join(' / ') : '(没有找到任何带 fileID 的记录)');

  if (!keys.length) {
    report.verdict = 'NO_IMAGE_RECORDS';
    report.hints.push('数据库里没有任何带 fileID 的配图记录，先去菜品页点「生成 AI 配图」。');
    return { ok: true, report };
  }

  // 3. 逐条检查：DB → 换链接 → 真的下载一次
  const results = [];
  for (const key of keys) {
    const one = { key };
    const doc = await readDoc(key);
    if (!doc || !doc.fileID) {
      one.status = (doc && doc.status) || '无记录';
      // pending / failed 与「从没生成过」是完全不同的状态，必须分开报：
      // 合在一起会让人以为功能坏了，其实只是图还在生成中（或上次失败了）。
      if (one.status === 'pending') {
        // pendingAt 缺失时 toMs 返回 0，会算出天文数字，兜底成 -1（显示「一段时间」）
        const pendingAt = toMs(doc && doc.pendingAt);
        one.pendingSeconds = pendingAt ? Math.round((Date.now() - pendingAt) / 1000) : -1;
        // 有 taskId ⇒ 异步任务在跑，等着就行；没有 ⇒ 旧同步模式被强杀留下的僵尸，
        // 它永远不会自己变成 ready，必须重新提交。这两种的处置完全不同，必须分开报。
        if (doc && doc.taskId) {
          one.step = 'GENERATING';
          one.taskId = doc.taskId;
          push(
            'db:' + key,
            '异步任务进行中（taskId=' + doc.taskId + '），已发起 ' + one.pendingSeconds + ' 秒'
          );
        } else {
          one.step = 'STUCK_PENDING';
          push(
            'db:' + key,
            '僵尸 pending：没有 taskId，说明云函数在等生图时被强杀（已卡 ' +
              one.pendingSeconds + ' 秒，永远不会自己好）'
          );
        }
      } else if (one.status === 'failed') {
        one.step = 'LAST_FAILED';
        one.lastError = (doc && doc.lastError) || '';
        one.failCount = doc && doc.failCount;
        push('db:' + key, '上次生成失败：' + String(one.lastError).slice(0, 200));
      } else {
        one.step = 'DB_NO_FILEID';
        push('db:' + key, '记录里没有 fileID（status=' + one.status + '）');
      }
      results.push(one);
      continue;
    }
    one.fileID = doc.fileID;
    one.status = doc.status;
    one.bytes = doc.bytes;

    // A/B：同一个 fileID，分别用「带 maxAge」和「裸字符串」换链接，各 GET 一次。
    // 若两种都 403 ⇒ 与 maxAge 无关（排除上一轮的主因）；若只有带 maxAge 的 403 ⇒ maxAge 被拒。
    const withAge = await toTempUrls([doc.fileID]);
    let bareUrl = '';
    try {
      const bare = await cloud.getTempFileURL({ fileList: [doc.fileID] });
      const f = (bare && bare.fileList && bare.fileList[0]) || {};
      bareUrl = f.tempFileURL || '';
    } catch (e) {
      bareUrl = '';
    }

    const url = withAge[doc.fileID] || bareUrl;
    if (!url) {
      one.step = 'TEMP_URL_FAILED';
      push('url:' + key, '有 fileID 但换不出临时链接 ⇒ 文件可能不存在或权限异常');
      results.push(one);
      continue;
    }
    one.url = url;
    // 关键诊断：文件路径里有没有百分号（cloudPath 非法字符）
    one.hasPercent = String(doc.fileID).indexOf('%') >= 0;
    one.urlQuery = String(url).slice(String(url).indexOf('?') + 1).slice(0, 200);

    const probe = await headOrGet(url);
    one.httpStatus = probe.status;
    one.httpErr = probe.err || '';
    push('http:' + key, 'GET 换出的链接 → ' + (probe.err ? 'ERR ' + probe.err : 'HTTP ' + probe.status));
    push('http:' + key, 'fileID 含百分号=' + one.hasPercent + '（cloudPath 里 % 是非法字符）');

    if (bareUrl && bareUrl !== url) {
      const bareProbe = await headOrGet(bareUrl);
      one.bareStatus = bareProbe.status;
      push('ab-maxage:' + key, '裸字符串(默认600s)→ HTTP ' + bareProbe.status + ' ；带 maxAge→ HTTP ' + probe.status);
    }
    results.push(one);
  }
  report.results = results;

  // 3b. ★ 对照实验：上传一个「纯 ASCII 文件名」的小文件，走完整同样的流程。
  //    这是把「路径问题」和「权限/链接问题」彻底分开的决定性证据：
  //      ASCII 探针 200 + 目标 403  ⇒ 文件名(cloudPath)有问题，与权限无关
  //      两者都 403                ⇒ 权限或环境层面问题
  try {
    const probeName = 'dish-images/_probe-' + Date.now() + '.txt';
    const up = await cloud.uploadFile({
      cloudPath: probeName,
      fileContent: Buffer.from('haofan-probe'),
    });
    const probeMap = await toTempUrls([up.fileID]);
    const probeUrl = probeMap[up.fileID];
    if (probeUrl) {
      const p = await headOrGet(probeUrl);
      report.asciiProbe = { cloudPath: probeName, status: p.status, err: p.err || '' };
      push('ascii-probe', probeName + ' → HTTP ' + (p.err ? 'ERR ' + p.err : p.status));
    } else {
      report.asciiProbe = { cloudPath: probeName, status: 0, err: '换不出链接' };
      push('ascii-probe', probeName + ' → 换不出临时链接');
    }
    // 探针文件删掉，别在存储里留垃圾
    try {
      await cloud.deleteFile({ fileList: [up.fileID] });
    } catch (e) {
      /* 删不掉不影响结论 */
    }
  } catch (e) {
    report.asciiProbe = { status: 0, err: (e && e.message) || 'upload failed' };
    push('ascii-probe', '上传探针失败：' + ((e && e.message) || ''));
  }

  // 3c. 失败档案：**没有 fileID 的菜在这一步之前就被 continue 掉了**，
  //     所以「上次为什么失败」必须在这里单独捞一次，否则排障时永远看不到 lastError。
  //     （这就是上一轮「点生成失败但诊断面板不给原因」的原因。）
  try {
    const failed = await db
      .collection('dishImages')
      .where({ status: 'failed' })
      .orderBy('failedAt', 'desc')
      .limit(3)
      .get();
    report.failedDocs = (failed.data || []).map((d) => ({
      key: d._id,
      failCount: d.failCount || 0,
      lastError: String(d.lastError || '').slice(0, 300),
    }));
    if (report.failedDocs.length) {
      report.failedDocs.forEach((d) =>
        push('failed:' + d.key, '第 ' + d.failCount + ' 次失败：' + d.lastError)
      );
    }
  } catch (e) {
    // 集合不存在或没建索引都可能在；失败不影响主结论
    push('failed-query', '查失败记录出错：' + ((e && e.message) || ''));
  }

  // 3d. 卡住的生成任务：pending 且带 taskId，但时间明显超过官方上限 ⇒ 任务真的死了
  try {
    const pending = await db
      .collection('dishImages')
      .where({ status: 'pending' })
      .limit(5)
      .get();
    report.pendingDocs = (pending.data || []).map((d) => ({
      key: d._id,
      taskId: d.taskId || '',
      pendingSeconds: toMs(d.pendingAt) ? Math.round((Date.now() - toMs(d.pendingAt)) / 1000) : -1,
    }));
    report.pendingDocs.forEach((d) => {
      if (d.taskId && (d.pendingSeconds > TASK_TTL_MS / 1000 || d.pendingSeconds < 0)) {
        push('pending:' + d.key, '任务卡住 ' + d.pendingSeconds + ' 秒仍未出图（taskId=' + d.taskId + '）');
      }
    });
  } catch (e) {
    push('pending-query', '查 pending 记录出错：' + ((e && e.message) || ''));
  }

  // 3e. 这道菜到底有没有记录？必须在通用兜底之前判掉。
  //     关键前情：results 是 foreach 出来的，它**只包含有 fileID 的记录**
  //     （没 fileID 的早在 3. 里 continue 掉，一个字段都没塞）。
  //     所以「点生成失败」时 results / withStatus 全是空数组，
  //     原先会一路掉到最后那句「未命中已知结论，请把 steps / results 发我」——
  //     等于让用户去发一个空的 results，这就是上一轮的诊断死角。
  const docForTarget = event && event.key ? await readDoc(String(event.key).trim()) : null;
  const hasResultForTarget = results.some((r) => r.key === (event && event.key));

  // 4. 汇总结论
  const bad = results.filter((r) => r.step);
  const withStatus = results.filter((r) => typeof r.httpStatus === 'number');
  if (bad.some((r) => r.step === 'STUCK_PENDING')) {
    report.verdict = 'STUCK_PENDING';
    report.hints.push(
      '★ 这条记录是**僵尸**：卡在 pending 而且没有 taskId ⇒ 云函数在等待生图时被**强杀**（超时），',
      '所以既不写 ready 也不写 failed，永远不会自己好。这是上一版同步等图的必然结果。',
      '处理：本版已改成异步（提交任务 + 轮询取结果），重新部署后点「换一张配图」即可重生成。'
    );
  } else if (bad.some((r) => r.step === 'GENERATING')) {
    report.verdict = 'GENERATING';
    const sec = (bad.find((r) => r.step === 'GENERATING') || {}).pendingSeconds;
    report.hints.push(
      '★ 这张图**正在生成中**，不是故障。生图实测 30 秒～2 分钟+（模型波动大）。',
      '已发起约 ' + (sec >= 0 ? sec + ' 秒' : '一段时间') + '。请稍等，页面会自动轮询出图，不必重进。',
      '如果超过 4 分钟仍无图：退出本页再进来即可（图落库后会直接显示）。'
    );
  } else if (bad.some((r) => r.step === 'LAST_FAILED')) {
    report.verdict = 'LAST_GENERATE_FAILED';
    const f = bad.find((r) => r.step === 'LAST_FAILED') || {};
    report.hints.push(
      '上次生成失败了（失败次数 ' + (f.failCount || '?') + '）：' + String(f.lastError).slice(0, 200),
      '连续失败会进入 2 分钟冷却，冷却期内点生成会被挡住——等一会儿再点即可。'
    );
  } else if (hasResultForTarget && bad.length === results.length && bad.every((r) => r.step === 'DB_NO_FILEID')) {
    report.verdict = 'NO_IMAGE_RECORDS';
    report.hints.push('记录存在但从来没有成功生成过图，点「生成 AI 配图」生成一张。');
  } else if (report.failedDocs && report.failedDocs.some((d) => d.key === (event && event.key))) {
    // 这道菜上次生成失败的原文：直接摆出来，不用再猜
    const f = report.failedDocs.find((d) => d.key === event.key);
    // 配额类错误单列：它占日常失败的大头，而且**处理动作与其它错误完全不同**
    // （401/404 是配置错了要改代码，配额耗尽是去服务商后台充钱，两者混着报会让人对着代码查半天）
    if (isQuotaError(f.lastError)) {
      report.verdict = 'QUOTA_EXHAUSTED';
      report.hints.push(
        '★ 生图配额用完了 —— **不是代码问题，不用改代码、不用重新部署**。',
        '服务商原文：' + String(f.lastError).slice(0, 300),
        '处理：登录服务商控制台（本项目是 open.bigmodel.cn）→ 费用中心 → 看**余额**与**资源包**。',
        '两个易混淆点：① 资源包通常**绑定模型**，买的是 glm-image 包就必须 IMAGE_API_MODEL=glm-image；',
        '② 资源包**到期即失效**（余额会显示为 0），不是被用完了才叫消耗完。'
      );
    } else {
      report.verdict = 'LAST_GENERATE_FAILED';
      report.hints.push(
        '★ 这道菜上次生成失败（第 ' + f.failCount + ' 次）：' + f.lastError,
        '生图接口报错原文如上：401/403 查 IMAGE_API_KEY；404 查 IMAGE_API_URL 与 IMAGE_API_MODEL；' +
          '429/1113 是配额耗尽（算下面的配额类）；若含 content_filter 则是提示词被安全策略拦了。',
        '连续失败 3 次会进入 2 分钟冷却，冷却期内点生成会被挡住——等一会儿再点即可。'
      );
    }
  } else if (docForTarget && (docForTarget.status === 'pending' || docForTarget.status === 'saving')) {
    // 图还没出来：pending 分两种（带 taskId＝在跑 / 不带＝旧版僵尸），这里统一按「还在生成」提示
    report.verdict = 'GENERATING';
    const sec = toMs(docForTarget.pendingAt)
      ? Math.round((Date.now() - toMs(docForTarget.pendingAt)) / 1000)
      : -1;
    report.hints.push(
      '★ 这道菜**正在生成中**，不是故障。生图实测 30 秒～2 分钟+（模型波动大）。',
      '已发起约 ' + (sec >= 0 ? sec + ' 秒' : '一段时间') + '。请稍等，页面会自动轮询出图，不必重进。',
      docForTarget.taskId
        ? '异步任务 id：' + docForTarget.taskId
        : '⚠️ 这条 pending 没有 taskId ⇒ 是旧版同步模式被强杀留下的**僵尸**，永远不会自己好，直接再点一次生成重提交即可。'
    );
  } else if (docForTarget && docForTarget.status === 'failed') {
    report.verdict = 'LAST_GENERATE_FAILED';
    report.hints.push(
      '★ 这道菜上次生成失败（第 ' + (docForTarget.failCount || '?') + ' 次）：' +
        String(docForTarget.lastError || '(没记错误原因)').slice(0, 300),
      '修复方向看上面的报错原文；连续失败 3 次会进入 2 分钟冷却。'
    );
  } else if (docForTarget) {
    // 有记录、不是失败也不是 pending，但没有 fileID：属于异常中间态
    report.verdict = 'NO_IMAGE_RECORDS';
    report.hints.push(
      '★ 这道菜有记录（status=' + (docForTarget.status || '空') + '）但没有 fileID ⇒ 从来没成功生成过图。',
      '点一次「生成 AI 配图」即可；若点了仍然失败，再点一次「诊断」就会显示具体报错原文。'
    );
  } else if (event && event.key) {
    // 连记录都没有：说明 generate 连「建 pending 记录」这一步都没走到
    report.verdict = 'NO_RECORD_AT_ALL';
    report.hints.push(
      '★ 数据库里**没有这道菜的任何记录** ⇒ 说明点「生成」时云函数压根没执行到写库那一步。',
      '常见原因按概率排序：① 云函数 dishImage 没部署/部署的是旧版本（先看上面 code-version 与 runtime 两行）；',
      '② 环境变量 IMAGE_API_URL / IMAGE_API_KEY 没配（看上面 env 那行，缺了会直接返回 NOT_CONFIGURED）；',
      '③ 调用被限流或云函数调用次数超免费额度（返回里会有 errCode）。',
      '下一步：先确认上面 env 行不是 (empty)；是 (empty) 就去云开发控制台补配置再部署。'
    );
  } else if (bad.some((r) => r.step === 'TEMP_URL_FAILED')) {
    report.verdict = 'TEMP_URL_FAILED';
    report.hints.push('云函数换不出临时链接：确认云存储里文件真的存在（控制台 → 存储 → dish-images/）。');
  } else if (withStatus.length && withStatus.every((r) => r.httpStatus === 200)) {
    report.verdict = 'SERVER_SIDE_OK';
    report.hints.push(
      '服务端全链路正常（文件在、链接能换、链接能下载到 200）⇒ 问题在小程序端渲染。',
      '最可能：该域名不在「downloadFile 合法域名」里（真机必现、模拟器勾了「不校验合法域名」才不报错）。',
      '检查：小程序后台 → 开发管理 → 开发设置 → 服务器域名 → downloadFile 合法域名，加上 https://<你的CDN域名>',
      '临时验证：开发者工具右上角「详情 → 本地设置」勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」。'
    );
  } else if (withStatus.length && withStatus.every((r) => r.httpStatus === 429)) {
    report.verdict = 'HTTP_429';
    report.hints.push('请求被限流（429）：稍后重试。');
  } else if (withStatus.some((r) => r.httpStatus === 403)) {
    // 403 对私有读桶有两种含义：链接被拒，或**对象不存在**（私有桶不会返回 404，
    // 否则等于泄露「哪些文件存在」）。靠 ASCII 对照实验区分。
    const asciiOk = report.asciiProbe && report.asciiProbe.status === 200;
    const targetHasPercent = withStatus.some((r) => r.hasPercent);
    if (asciiOk && targetHasPercent) {
      report.verdict = 'BAD_CLOUD_PATH';
      report.hints.push(
        '★ 已定位：cloudPath 含百分号（%）。官方文档规定 cloudPath 只能包含 ' +
          '[0-9,a-z,A-Z]、/、!、-、_、.、* 和中文，% 是非法字符。',
        '代码用 encodeURIComponent(菜名) 拼路径，把中文变成了 %E8%91%B1… ⇒ 文件存进去但取不出来（私有桶返回 403）。',
        '修复已在本版提供：改用 safeCloudPath()（保留中文、剔除非法字符），' +
          '重新部署后把这张图重新生成一次即可（点「换一张配图」）。'
      );
    } else if (asciiOk) {
      report.verdict = 'HTTP_403_TARGET_ONLY';
      report.hints.push(
        '对照实验显示：纯 ASCII 新文件能正常 200，只有这道菜的旧文件 403。',
        '⇒ 是这些**已存下来的旧文件**取不到（路径或权限），不是整体机制问题。',
        '处理：点「换一张配图」重新生成一张即可，旧文件可不管。'
      );
    } else {
      report.verdict = 'HTTP_403';
      report.hints.push(
        '连纯 ASCII 的新探针文件也 403 ⇒ 是权限/环境层面问题，不是文件名。',
        '查：云存储权限是否锁死「仅创建者可读写」且本云函数环境与目标桶不一致。'
      );
    }
  } else if (withStatus.some((r) => r.httpStatus === 404)) {
    report.verdict = 'HTTP_404';
    report.hints.push('文件路径不存在（404）：查云存储里实际文件名与 cloudPath 是否一致。');
  } else if (withStatus.length && withStatus.every((r) => r.httpStatus === 0)) {
    // 云函数（境内节点）都连不上这个域名 ⇒ 域名不可达，不是签名问题
    report.verdict = 'CDN_UNREACHABLE';
    report.hints.push(
      '换出的链接在云函数里都连不上（HTTP 0 / 网络错误）⇒ 域名不可达或链接已被拒。',
      '先确认云存储里有文件；若域名是默认 tcb.qcloud.la，检查是否被防火墙/白名单挡掉。',
      '把上面的 httpErr 发我，可直接看出是 DNS 失败、连接被拒还是超时。'
    );
  } else {
    // 走到这里说明「目标菜的记录状态正常但图仍不可用」，且不属于上面任何一类。
    // 老文案让用户「把 steps / results 发我」，可 results 这时很可能是空的
    // （只在有 fileID 时才 push），发了也没用 ⇒ 改成给出可照着做的三段式指引。
    report.verdict = 'NEED_MANUAL_LOOK';
    report.hints.push(
      '未命中已知结论。可照着这三段自查，比把空 results 发出来快：',
      '① 看上面 env 行：IMAGE_API_URL 是 (empty) ⇒ 环境变量没配；',
      '② 看 code-version 行：hasMaxAge=false ⇒ 云端跑的还是旧代码，重新部署；',
      '③ 看 runtime 行：timeout 明显小于 180000ms ⇒ 同步等图会被强杀，确认走的是异步链路。',
      '把本页「复制诊断结果」整段发我，我按 steps 逐行定位。'
    );
  }

  return { ok: true, report };
}

/** 用 GET 真下一下（有些 CDN 不响应 HEAD），只看状态码，取到响应头就断开 */
function headOrGet(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (o) => {
      if (done) return;
      done = true;
      resolve(o);
    };
    let req;
    try {
      const mod = String(url).indexOf('http:') === 0 ? http : https;
      req = mod.get(url, (res) => {
        res.resume(); // 丢掉 body，只取状态码
        finish({ status: res.statusCode });
      });
    } catch (e) {
      return finish({ status: 0, err: e && e.message });
    }
    req.on('error', (e) => finish({ status: 0, err: (e && e.message) || 'request error' }));
    req.setTimeout(15000, () => {
      req.destroy();
      finish({ status: 0, err: 'timeout' });
    });
  });
}

/**
 * list —— 配图管理页用：把 dishImages 全量（上限 200 条）带图返回。
 *
 * 为什么要它：用户问「我有 12 张配图，但我没生成这么多，是不是重复扣费了」。
 * 这种疑问光靠对话解释解不掉 —— 得让他自己**看得见每一张的账**：
 * 每个菜名显示 submitCount（真正调过几次付费接口）、状态、生成时间、失败原因。
 * 一次就敢确认有没有多花钱，不用再来问我。
 *
 * 排序放在这里做：集合没建索引，云端 orderBy 可能直接报错。
 */
async function list(event) {
  const limit = Math.min(200, Math.max(1, Number((event && event.limit) || 200)));
  const res = await db.collection('dishImages').limit(limit).get();
  const docs = (res && res.data) || [];

  const ids = docs.filter((d) => d.fileID).map((d) => d.fileID);
  const urls = await toTempUrls(ids);

  const items = docs.map((d) => ({
    key: d._id,
    title: d.title || d._id,
    status: d.status || 'none',
    hasImage: !!d.fileID,
    url: d.fileID ? urls[d.fileID] || '' : '',
    bytes: d.bytes || 0,
    fileID: d.fileID || '',
    model: d.model || '',
    // 真正的付费提交次数 —— 核对有没有重复扣费就看这个
    submitCount: d.submitCount || 0,
    failCount: d.failCount || 0,
    lastError: String(d.lastError || '').slice(0, 200),
    generatedAt: toMs(d.generatedAt),
    pendingAt: toMs(d.pendingAt),
    taskId: d.taskId || '',
  }));

  // 有图的在前，同组内按生成时间倒序；pending/failed 这类「还没结果」的排最后
  items.sort((a, b) => {
    const ra = a.hasImage ? 0 : 1;
    const rb = b.hasImage ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return b.generatedAt - a.generatedAt;
  });

  return { ok: true, items, total: items.length };
}

/**
 * remove —— 删掉一张配图（存储文件 + 数据库记录）。
 *
 * 用得上的场景：生成的图明显不对版（画成了别的菜），留着它每次都会命中缓存，
 * 用户怎么点「换一张」都可能拿回同一张不匹配的名字——因为 _id 是菜名、picture 是按收藏重用。
 * 删掉记录、让它重新生成一次才是干净的解。
 *
 * @param {{ key: string }} event
 */
async function remove(event) {
  const key = String((event && event.key) || '').trim();
  if (!key) return { ok: false, message: '缺少菜名' };

  const doc = await readDoc(key);
  if (!doc) return { ok: false, message: '没有这道菜的记录' };

  let fileDeleted = false;
  if (doc.fileID) {
    try {
      await cloud.deleteFile({ fileList: [doc.fileID] });
      fileDeleted = true;
    } catch (e) {
      // 文件也许早就不在了；记录删干净了就不影响重新生成，所以不算失败
      console.warn('[dishImage] remove: 删除存储文件失败', key, e && e.message);
    }
  }

  try {
    await db.collection('dishImages').doc(key).remove();
  } catch (e) {
    return { ok: false, message: '删除记录失败：' + ((e && e.message) || '') };
  }

  console.log('[dishImage] removed', key, 'fileDeleted=' + fileDeleted);
  return { ok: true, key, fileDeleted };
}

exports.main = async (event, context) => {
  try {
    const action = event && event.action;
    switch (action) {
      case 'resolve':
        return await resolve(event || {});
      case 'generate':
        return await generate(event || {});
      case 'stats':
        return await stats();
      case 'diag':
        return await diag(event || {});
      case 'selfcheck':
        // context 用来读云函数的真实超时配置（判断同步等生图会不会被强杀）
        return await selfcheck(event || {}, context);
      case 'list':
        // 配图管理页：每一张的账都摊开给人看（提交次数 / 状态 / 失败原因）
        return await list(event || {});
      case 'remove':
        return await remove(event || {});
      default:
        return { ok: false, message: '未知 action：' + action };
    }
  } catch (e) {
    console.error('[dishImage] failed', e);
    return { ok: false, message: '配图服务失败：' + (e && e.message ? e.message : '未知错误') };
  }
};

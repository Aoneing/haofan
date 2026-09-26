'use strict';

const cloud = require('wx-server-sdk');
const https = require('https');
const http = require('http');
const net = require('net');

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
 *
 * 落库前一律压缩：设计文档 07 节要求单图 40–80KB，直接存 1024 PNG 约 1–2MB，
 * 会白白吃掉云开发 2GB 共享容量。压缩用纯 JS 的 jimp，失败则原样保存不阻断。
 *
 * 关于「图片怎么送到前端」（重要，2026-09-26 踩过）：
 *  本环境云存储权限被锁死为「仅创建者可读写」（免费套餐下控制台改权限会提示「请升级至付费版」）。
 *  配图是云函数上传的，客户端不是「创建者」⇒ 把 cloud:// 直接填进 image 的 src 会被拒，
 *  表现为图区空白 + wx.previewImage 一直转圈。
 *  ⇒ 因此所有出参统一用管理员身份换成 https 临时链接（见 toTempUrls），前端只用 https。
 *  私有读的临时链接有有效期（约 2 小时），前端只在内存里缓存并按 TTL 定期重取。
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
 */
async function toTempUrls(fileIDs) {
  const list = (fileIDs || []).filter(Boolean);
  const map = {};
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    try {
      const res = await cloud.getTempFileURL({ fileList: chunk });
      (res && res.fileList ? res.fileList : []).forEach((f) => {
        if (f && f.fileID && f.tempFileURL) map[f.fileID] = f.tempFileURL;
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
  res.data.forEach((doc) => {
    if (doc.fileID) files[doc._id] = doc.fileID;
  });

  // 客户端读不了私有文件，统一换成 https 临时链接再返回
  const urls = await toTempUrls(Object.keys(files).map((k) => files[k]));
  const map = {}; // 菜名 -> https 临时链接（前端直接用于 image / previewImage）
  Object.keys(files).forEach((k) => {
    if (urls[files[k]]) map[k] = urls[files[k]];
  });
  if (Object.keys(files).length && !Object.keys(map).length) {
    console.warn('[dishImage] resolve 有 fileID 但临时链接全部换取失败，检查云存储文件是否存在');
  }

  return { ok: true, map, files, missing: uniq.filter((k) => !files[k]) };
}

/** 生图幂等窗口：同一 key 在这段时间内重复请求直接复用，不重复调接口（重复调用＝重复扣费） */
const PENDING_WINDOW_MS = 3 * 60 * 1000;
/** 连续失败冷却：接口异常时不反复烧钱 */
const FAIL_COOLDOWN_MS = 2 * 60 * 1000;
const FAIL_COOLDOWN_THRESHOLD = 3;

/** Date / ISO 字符串 / 时间戳 → 毫秒，取不到就返回 0（当作很久以前） */
function toMs(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
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

/** 写状态标记（pending / ready / failed）。写失败不能阻断主流程 */
async function markDoc(key, data) {
  try {
    await db
      .collection('dishImages')
      .doc(key)
      .set({ data: Object.assign({ updatedAt: db.serverDate() }, data) });
  } catch (e) {
    console.warn('[dishImage] markDoc failed:', e && e.message);
  }
}

/**
 * { key, title? } → 生成一张配图，上传云存储，写入 dishImages
 *
 * 关于耗时：单张生图实测 20–90 秒，可能超过调用方（客户端 / 控制台「云端测试」）的等待上限。
 * 调用方超时会断开并报错，但云函数仍在后台跑完并落库 —— 所以调用方报错 ≠ 生成失败。
 * 因此：本函数保持「同步跑完再返回」以保证一定能落库；前端改为发起后轮询 resolve，
 * 不依赖这一次调用的返回值。详见 miniprogram/pages/dish/dish.js。
 */
async function generate(event) {
  const key = String(event.key || '').trim();
  const title = String(event.title || '').trim() || key;
  if (!key) return { ok: false, message: '缺少 key（归一化菜名）' };

  // 0. 幂等保护：成品直接复用；生成中/冷却期直接返回，不重复计费。
  //    force=true 表示用户明确点了「换一张配图」，此时要真的重生成（否则按钮永远换不了图）。
  //    注意：pending 窗口对 force 依然生效 —— 连点两下仍会被挡住，不会重复扣费。
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
    if (prev.status === 'pending' && Date.now() - toMs(prev.pendingAt) < PENDING_WINDOW_MS) {
      return { ok: true, key, pending: true, message: '上一张还在生成中' };
    }
    if (
      prev.status === 'failed' &&
      (prev.failCount || 0) >= FAIL_COOLDOWN_THRESHOLD &&
      Date.now() - toMs(prev.failedAt) < FAIL_COOLDOWN_MS
    ) {
      const wait = Math.ceil((FAIL_COOLDOWN_MS - (Date.now() - toMs(prev.failedAt))) / 1000);
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

  const prompt =
    '一道家常辅食/菜品的手机美食摄影照片：「' +
    title +
    '」。俯拍视角，白瓷餐具，木质餐桌，柔和自然光，温暖色调，食物清晰占满画面主体，背景干净，无文字无水印。';

  const size = process.env.IMAGE_API_SIZE || '1024x1024';

  await markDoc(key, {
    title,
    status: 'pending',
    pendingAt: new Date(),
    failCount: (prev && prev.failCount) || 0,
  });

  const t0 = Date.now();
  console.log('[dishImage] generate start', key, 'model=' + model, 'size=' + size);

  try {
    const apiRes = await postJson(
      apiUrl,
      { Authorization: 'Bearer ' + apiKey },
      { model, prompt, n: 1, size }
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

    // 落库前压缩到设计文档要求的规格（640px / JPEG q70 ≈ 40–80KB）
    const packed = await compressForStorage(raw);
    const cloudPath =
      'dish-images/' + encodeURIComponent(key) + '-' + Date.now() + '.' + packed.ext;
    const up = await cloud.uploadFile({ cloudPath, fileContent: packed.buffer });
    const fileID = up.fileID;

    await markDoc(key, {
      fileID,
      title,
      prompt,
      source: 'ai',
      model,
      requestSize: size,
      bytes: packed.buffer.length,
      rawBytes: raw.length,
      status: 'ready',
      generatedAt: db.serverDate(),
      // 智谱返回的 content_filter 自带安全判定，落库备查（P-1 内容安全）
      contentFilter: apiRes.content_filter || null,
    });

    console.log(
      '[dishImage] generate done',
      key,
      Date.now() - t0 + 'ms',
      'bytes=' + packed.buffer.length,
      'rawBytes=' + raw.length
    );

    return {
      ok: true,
      key,
      fileID,
      url: (await toTempUrls([fileID]))[fileID] || '',
      bytes: packed.buffer.length,
      rawBytes: raw.length,
      genMs: Date.now() - t0,
    };
  } catch (e) {
    const msg = (e && e.message) || '生图失败';
    console.error('[dishImage] generate failed', key, Date.now() - t0 + 'ms', msg);
    await markDoc(key, {
      title,
      status: 'failed',
      failCount: ((prev && prev.failCount) || 0) + 1,
      lastError: String(msg).slice(0, 300),
      failedAt: new Date(),
      // 保留上一次成功的图，避免失败后连旧图也丢了
      fileID: (prev && prev.fileID) || '',
    });
    return { ok: false, key, code: 'GENERATE_FAILED', message: msg, genMs: Date.now() - t0 };
  }
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
          prompt: '一道家常辅食的照片：「番茄炒蛋」，俯拍，白瓷盘，自然光。',
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

exports.main = async (event) => {
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
      default:
        return { ok: false, message: '未知 action：' + action };
    }
  } catch (e) {
    console.error('[dishImage] failed', e);
    return { ok: false, message: '配图服务失败：' + (e && e.message ? e.message : '未知错误') };
  }
};

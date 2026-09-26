'use strict';

const cloud = require('wx-server-sdk');
const https = require('https');
const http = require('http');

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

/** { keys: [...] } → { map: { 菜名: fileID }, missing: [...] }，批量给周视图/日视图用 */
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

  const map = {};
  res.data.forEach((doc) => {
    if (doc.fileID) map[doc._id] = doc.fileID;
  });
  return { ok: true, map, missing: uniq.filter((k) => !map[k]) };
}

/** { key, title? } → 生成一张配图，上传云存储，写入 dishImages */
async function generate(event) {
  const key = String(event.key || '').trim();
  const title = String(event.title || '').trim() || key;
  if (!key) return { ok: false, message: '缺少 key（归一化菜名）' };

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

  const apiRes = await postJson(
    apiUrl,
    { Authorization: 'Bearer ' + apiKey },
    { model, prompt, n: 1, size }
  );

  const item = apiRes && apiRes.data && apiRes.data[0];
  if (!item) return { ok: false, message: '生图接口未返回图片数据' };

  let raw;
  if (item.b64_json) {
    raw = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    // 接口给外链时中转下载再入云存储，避免外链过期
    raw = await download(item.url);
  } else {
    return { ok: false, message: '生图接口返回格式无法识别' };
  }

  // 落库前压缩到设计文档要求的规格（640px / JPEG q70 ≈ 40–80KB）
  const packed = await compressForStorage(raw);
  const cloudPath =
    'dish-images/' + encodeURIComponent(key) + '-' + Date.now() + '.' + packed.ext;
  const up = await cloud.uploadFile({ cloudPath, fileContent: packed.buffer });
  const fileID = up.fileID;

  await db.collection('dishImages').doc(key).set({
    data: {
      fileID,
      title,
      prompt,
      source: 'ai',
      model,
      requestSize: size,
      bytes: packed.buffer.length,
      rawBytes: raw.length,
      generatedAt: db.serverDate(),
    },
  });

  return { ok: true, key, fileID, bytes: packed.buffer.length, rawBytes: raw.length };
}

/** 配图库统计（我的页展示） */
async function stats() {
  const total = await db.collection('dishImages').count();
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
      default:
        return { ok: false, message: '未知 action：' + action };
    }
  } catch (e) {
    console.error('[dishImage] failed', e);
    return { ok: false, message: '配图服务失败：' + (e && e.message ? e.message : '未知错误') };
  }
};

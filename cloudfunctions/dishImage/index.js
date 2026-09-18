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
 *  IMAGE_API_URL    例如 https://api.openai.com/v1/images/generations（或任意兼容网关）
 *  IMAGE_API_KEY    对应 Bearer Token
 *  IMAGE_API_MODEL  可选，默认 gpt-image-1
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

  const apiRes = await postJson(
    apiUrl,
    { Authorization: 'Bearer ' + apiKey },
    { model, prompt, n: 1, size: '1024x1024' }
  );

  const item = apiRes && apiRes.data && apiRes.data[0];
  if (!item) return { ok: false, message: '生图接口未返回图片数据' };

  let cloudPath = 'dish-images/' + encodeURIComponent(key) + '-' + Date.now() + '.png';
  let fileID;

  if (item.b64_json) {
    const buffer = Buffer.from(item.b64_json, 'base64');
    const up = await cloud.uploadFile({ cloudPath, fileContent: buffer });
    fileID = up.fileID;
  } else if (item.url) {
    // 接口给外链时中转下载再入云存储，避免外链过期
    const bin = await new Promise((resolve, reject) => {
      const mod = item.url.indexOf('http:') === 0 ? http : https;
      const req = mod.get(item.url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('图片下载超时')));
    });
    const up = await cloud.uploadFile({ cloudPath, fileContent: bin });
    fileID = up.fileID;
  } else {
    return { ok: false, message: '生图接口返回格式无法识别' };
  }

  await db.collection('dishImages').doc(key).set({
    data: {
      fileID,
      title,
      prompt,
      source: 'ai',
      model,
      generatedAt: db.serverDate(),
    },
  });

  return { ok: true, key, fileID };
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

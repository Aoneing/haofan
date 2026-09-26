// utils/imageStore.js — 菜名 → 配图 URL 的内存缓存
//
// 为什么缓存的是 https 链接、而不是 cloud:// 文件 ID：
//   本环境云存储权限被锁死为「仅创建者可读写」（免费套餐下控制台不给改，提示需升级付费版），
//   而配图是云函数上传的，客户端不是「创建者」——直接拿 fileID 当 image 的 src 会被拒，
//   表现为图区空白 + wx.previewImage 一直转圈。
//   所以云函数 dishImage 会先用管理员身份换成带签名的 https 临时链接再返回，前端只用 https。
//
// 为什么要有 TTL：
//   私有读的临时链接有有效期（约 2 小时），过期后再用会 403。这里按 30 分钟保守过期，
//   过期后下一次 hydrate 会重新取一张，不会一直拿着死链接。
//   缓存只在内存里（不落 Storage），冷启动天然拿到新链接。
const api = require('./api');

/** 保守过期时间：私有读临时链接实测有效约 2 小时，这里提前到 30 分钟重取 */
const URL_TTL_MS = 30 * 60 * 1000;

const cache = {}; // key -> { url, at }
let pending = null; // 合并并发的 hydrate 请求

function get(key) {
  const item = key && cache[key];
  return (item && item.url) || '';
}

function set(key, url) {
  if (key && url) cache[key] = { url, at: Date.now() };
}

function clear() {
  Object.keys(cache).forEach((k) => delete cache[k]);
}

/**
 * 批量解析配图并写入缓存。
 *
 * 两个坑：
 * 1) 不能「有在途请求就直接复用」——那样本次新增的 key 会被静默丢弃，
 *    导致这部分菜名本轮拿不到图（页面已经渲染完，不会再触发第二次 hydrate）。
 *    所以把在途请求当作「前置依赖」串起来：等它落地后重新计算差集，缺什么再补一轮。
 * 2) 判断「要不要重取」看的是 TTL，不是「缓存里有没有」。链接会过期，
 *    只看有无会把过期链接一直用下去。
 *
 * @param {string[]} keys
 * @param {{force?: boolean}} [opts] force=true 时无视 TTL 全量重取（图片加载失败后的自愈用）
 */
function hydrate(keys, opts) {
  const force = !!(opts && opts.force);
  const wanted = (keys || []).filter(Boolean);

  const step = () => {
    const now = Date.now();
    const missing = [];
    const seen = {};
    wanted.forEach((k) => {
      const item = cache[k];
      const stale = force || !item || now - item.at > URL_TTL_MS;
      if (stale && !seen[k]) {
        seen[k] = true;
        missing.push(k);
      }
    });
    if (!missing.length) return Promise.resolve(cache);
    return api
      .image('resolve', { keys: missing })
      .then((res) => {
        if (res && res.ok && res.map) {
          Object.keys(res.map).forEach((k) => set(k, res.map[k]));
        }
        return cache;
      })
      .catch(() => cache);
  };

  // 链在在途请求之后，保证并发调用不会互相覆盖差集
  const run = (pending || Promise.resolve()).then(step, step);
  const tracked = run.then(
    (c) => {
      if (pending === tracked) pending = null;
      return c;
    },
    (c) => {
      if (pending === tracked) pending = null;
      return c;
    }
  );
  pending = tracked;
  return tracked;
}

/** 强制重取（忽略 TTL）。用于图片加载失败后的自愈：链接可能提前失效。 */
function reload(keys) {
  return hydrate(keys, { force: true });
}

module.exports = { get, set, clear, hydrate, reload, URL_TTL_MS };

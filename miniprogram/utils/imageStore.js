// utils/imageStore.js — 菜名 → 云存储图片 的内存缓存
// 页面渲染前先 hydrate(keys) 批量解析一次，dish-thumb 从缓存同步取值，避免每个格子一次请求。
const api = require('./api');

const cache = {}; // key -> fileID
let pending = null; // 合并并发的 hydrate 请求

function get(key) {
  return (key && cache[key]) || '';
}

function set(key, fileID) {
  if (key && fileID) cache[key] = fileID;
}

function clear() {
  Object.keys(cache).forEach((k) => delete cache[k]);
}

/**
 * 批量解析配图并写入缓存。
 * 注意：不能「有在途请求就直接复用」——那样本次新增的 key 会被静默丢弃，
 * 导致这部分菜名本轮拿不到图（页面已经渲染完，不会再触发第二次 hydrate）。
 * 因此把在途请求当作「前置依赖」串起来：等它落地后重新计算差集，缺什么再补一轮。
 */
function hydrate(keys) {
  const wanted = (keys || []).filter(Boolean);

  const step = () => {
    const missing = [];
    const seen = {};
    wanted.forEach((k) => {
      if (!cache[k] && !seen[k]) {
        seen[k] = true;
        missing.push(k);
      }
    });
    if (!missing.length) return Promise.resolve(cache);
    return api
      .image('resolve', { keys: missing })
      .then((res) => {
        if (res && res.ok && res.map) Object.assign(cache, res.map);
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

module.exports = { get, set, clear, hydrate };

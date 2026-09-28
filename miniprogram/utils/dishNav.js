// utils/dishNav.js — 页面之间传递「菜品做法」的临时中转站
//
// 为什么不直接拼进 navigateTo 的 url：做法是从 Excel 里解析出来的长文本（几十到上百字），
// encodeURIComponent 之后体积还要再涨，而 wx.navigateTo 的 url 有长度上限，超了就直接
// navigateTo:fail（现象是点了没反应，很难查）。
//
// 所以走内存中转：跳之前 put(key, payload)，落地页 onLoad 里 take(key) 取走。
// 只在内存里存一份，不落 storage、不进全局持久化，取完即弃。
const cache = Object.create(null);

/** 存入（同 key 覆盖） */
function put(key, payload) {
  if (!key) return;
  cache[key] = payload || {};
}

/** 取走（取到即删，避免同一份做法被后续同 key 跳转误用） */
function take(key) {
  if (!key) return null;
  const v = cache[key];
  delete cache[key];
  return v || null;
}

/** 只看不取（调试/兜底用） */
function peek(key) {
  return key ? cache[key] || null : null;
}

function clear() {
  Object.keys(cache).forEach((k) => delete cache[k]);
}

module.exports = { put, take, peek, clear };

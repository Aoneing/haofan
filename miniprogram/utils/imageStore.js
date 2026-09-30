// utils/imageStore.js — 菜名 → 配图 URL 的内存缓存
//
// 为什么缓存的是 https 链接、而不是 cloud:// 文件 ID：
//   本环境云存储权限被锁死为「仅创建者可读写」（免费套餐下控制台不给改，提示需升级付费版），
//   而配图是云函数上传的，客户端不是「创建者」——直接拿 fileID 当 image 的 src 会被拒，
//   表现为图区空白 + wx.previewImage 一直转圈。
//   所以云函数 dishImage 会先用管理员身份换成带签名的 https 临时链接再返回，前端只用 https。
//
// 为什么要有 TTL：
//   私有读的临时链接**默认只有 10 分钟有效**（官方 getTempFileURL 文档：公有读不过期、
//   私有读十分钟）。云函数 dishImage 里已显式把 maxAge 申请成 6 小时（见 toTempUrls），
//   但这里仍按自己的 TTL 保守过期，不依赖签发侧。
//   ⚠️ TTL 必须**小于**链接实际有效期。2026-09-27 就是 TTL 写成 30 分钟、
//   而链接只有 10 分钟，中间 20 分钟一直在用死链接 ⇒ 图区空白且重进页面也不恢复。
//   缓存只在内存里（不落 Storage），冷启动天然拿到新链接。
const api = require('./api');

/**
 * 保守过期时间。
 * 链接签发侧申请的是 6 小时，这里压到 5 分钟：比任何可能的签发有效期都短，
 * 宁可偶尔多换一次链接（一次批量请求，几乎无成本），也不能再出现「拿着死链接渲染」。
 * 图片显示不出来是用户直接可见的故障；多一次 resolve 调用是纯后台开销。
 */
const URL_TTL_MS = 5 * 60 * 1000;

const cache = {}; // key -> { url, at }
const states = {}; // key -> 最近一次后端给的生成状态（'pending' / 'ready' / 'failed' / 'none'）
let pending = null; // 合并并发的 hydrate 请求

function get(key) {
  const item = key && cache[key];
  return (item && item.url) || '';
}

/**
 * 取某道菜最近一次已知的生成状态。
 *
 * 为什么要单独存一份：云函数 resolve 本来就把每道菜的 status 放在 `states` 里返回，
 * 但 hydrate 以前只往缓存里塞「已经好了的图链接」，**把 states 整个丢掉了**。
 * 后果就是用户点完生成、退出页面、再进来时，页面完全不知道还有个任务在跑 ——
 * 既不显示「生成中」，也不会恢复轮询，只能再点一次（2026-09-30 用户实踩，
 * 而且第二次点击还让他担心是不是重复扣了资源包的次数）。
 */
function getState(key) {
  return (key && states[key]) || '';
}

/**
 * 只取仍然新鲜（未超 TTL）的链接。
 *
 * ⚠️ 必须用这个、不要用 get() 来喂 <image> 的 src：
 * get() 是「有什么给什么」，会把过期链接也交出去，渲染出来就是 403 灰底空白。
 * 页面 onShow 先要一个能立刻渲染的值（不阻塞等网络），所以取不到就返回空串，
 * 交给随后的 hydrate 去换新链接。
 */
function getFresh(key) {
  const item = key && cache[key];
  if (!item || !item.url) return '';
  if (Date.now() - item.at > URL_TTL_MS) return ''; // 已过期，别拿去渲染
  return item.url;
}

function set(key, url) {
  if (key && url) cache[key] = { url, at: Date.now() };
}

function clear() {
  Object.keys(cache).forEach((k) => delete cache[k]);
  Object.keys(states).forEach((k) => delete states[k]);
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
        // states 必须一起存下来：它是「退出页面再回来还能接着等」的唯一依据。
        // 这里传的 collect=false，云函数会原样返回库里的 status，不会顺手去重收图。
        if (res && res.ok && res.states) {
          Object.keys(res.states).forEach((k) => {
            states[k] = res.states[k] || 'none';
          });
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

/**
 * 直接问一次服务端这道菜的状态（不看缓存、不换链接）。
 *
 * 为什么不复用 hydrate：hydrate 在缓存还新鲜时会**直接跳过请求**，
 * 而「重进页面时问一句还在不在生成」恰恰必须在缓存新鲜时也发出去
 * ——否则用户退出再进来，页面依旧一副「什么都没发生」的样子。
 *
 * @param {string} key
 * @returns {Promise<string>} 'pending' / 'saving' / 'ready' / 'failed' / 'none' / ''
 */
function refreshState(key) {
  if (!key) return Promise.resolve('');
  return api
    .image('resolve', { keys: [key] })
    .then((res) => {
      const st = (res && res.states && res.states[key]) || '';
      if (st) states[key] = st;
      // 顺手把图也更新了：既然已经问过一次，别让用户再多等一轮 hydrate
      const url = res && res.map ? res.map[key] : '';
      if (url) set(key, url);
      return st;
    })
    .catch(() => '');
}

/** 强制重取（忽略 TTL）。用于图片加载失败后的自愈：链接可能提前失效。 */
function reload(keys) {
  return hydrate(keys, { force: true });
}

module.exports = { get, getFresh, getState, refreshState, set, clear, hydrate, reload, URL_TTL_MS };

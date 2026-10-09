// utils/api.js — 云函数调用的统一封装
//
// 2026-10-09 性能优化：加一层「读缓存」。
// 背景：4 个 tab 页 onShow 每次都无脑打云函数，免费档 SCF 冷启动 + 网络往返
// 让切 tab 总有「冷启动感」。家庭 app 数据分钟级变化即可，加 60s TTL 缓存后，
// 在缓存有效期内切回任意页都直接走内存、零网络等待；变更类操作（导入/落库）后
// 主动清缓存，保证写后读一致。
const READ_TTL = 60 * 1000; // 60 秒：家庭食谱数据分钟级新鲜度足够
const _cache = new Map(); // key(`name#data`) -> { ts, value }

// 走缓存的只读 action（menuQuery 侧 / dishImage 侧分开声明）
const MENU_QUERY_READ = ['getContext', 'getWeek', 'getDay', 'listPeriods', 'getRecentWeeks', 'getAllStats'];
const DISH_IMAGE_READ = ['stats', 'list'];

function keyOf(name, data) {
  return name + '#' + JSON.stringify(data || {});
}

function call(name, data, opts) {
  opts = opts || {};
  const useCache = !!opts.cache;
  const key = keyOf(name, data);
  if (useCache) {
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.ts < READ_TTL) {
      return Promise.resolve(hit.value);
    }
  }
  return new Promise((resolve, reject) => {
    wx.cloud
      .callFunction({ name, data })
      .then((res) => {
        const r = res && res.result;
        if (!r) {
          reject(new Error('云函数 ' + name + ' 无返回'));
          return;
        }
        if (useCache) _cache.set(key, { ts: Date.now(), value: r });
        resolve(r);
      })
      .catch((err) => {
        reject(new Error((err && err.errMsg) || '调用 ' + name + ' 失败'));
      });
  });
}

module.exports = {
  /** 解析 Excel：{ fileID, yearOverride? } —— 变更类，成功后清缓存 */
  parse(fileID, yearOverride) {
    return call('menuParse', { fileID, yearOverride }).then((r) => {
      _cache.clear();
      return r;
    });
  },

  /** 落库：{ period, days, stats?, mode? } —— 变更类，成功后清缓存 */
  save(payload) {
    return call('menuSave', payload).then((r) => {
      _cache.clear();
      return r;
    });
  },

  /** menuQuery：getContext / getWeek / getDay / listPeriods / getRecentWeeks（只读，默认缓存） */
  query(action, data, opts) {
    const cacheable = MENU_QUERY_READ.indexOf(action) >= 0;
    const useCache = !!(opts && opts.cache) || (cacheable && !(opts && opts.noCache));
    return call('menuQuery', Object.assign({ action }, data || {}), { cache: useCache });
  },

  /** dishImage：resolve / generate / stats / diag / selfcheck
   *  stats / list 只读默认缓存；resolve / generate 是轮询与写，绝不可缓存。 */
  image(action, data, opts) {
    const cacheable = DISH_IMAGE_READ.indexOf(action) >= 0;
    const useCache = !!(opts && opts.cache) || (cacheable && !(opts && opts.noCache));
    return call('dishImage', Object.assign({ action }, data || {}), { cache: useCache });
  },

  /** 上传 Excel 到云存储，返回 fileID */
  uploadExcel(filePath, fileName) {
    const cloudPath = 'imports/' + Date.now() + '-' + (fileName || 'menu.xlsx');
    return new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath,
        filePath,
        success: (res) => resolve(res.fileID),
        fail: (err) => reject(new Error((err && err.errMsg) || '上传失败')),
      });
    });
  },

  /** 主动清缓存（导入/落库已自动清；特殊场景可手动调） */
  clearCache() {
    _cache.clear();
  },
};

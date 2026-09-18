// utils/api.js — 云函数调用的统一封装
function call(name, data) {
  return new Promise((resolve, reject) => {
    wx.cloud
      .callFunction({ name, data })
      .then((res) => {
        const r = res && res.result;
        if (!r) {
          reject(new Error('云函数 ' + name + ' 无返回'));
          return;
        }
        resolve(r);
      })
      .catch((err) => {
        reject(new Error((err && err.errMsg) || '调用 ' + name + ' 失败'));
      });
  });
}

module.exports = {
  /** 解析 Excel：{ fileID, yearOverride? } */
  parse(fileID, yearOverride) {
    return call('menuParse', { fileID, yearOverride });
  },

  /** 落库：{ period, days, stats?, mode? } */
  save(payload) {
    return call('menuSave', payload);
  },

  /** menuQuery：getContext / getWeek / getDay / listPeriods */
  query(action, data) {
    return call('menuQuery', Object.assign({ action }, data || {}));
  },

  /** dishImage：resolve / generate / stats */
  image(action, data) {
    return call('dishImage', Object.assign({ action }, data || {}));
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
};

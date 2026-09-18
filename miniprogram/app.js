// app.js — 好饭
const config = require('./config');

App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库版本过低（需 ≥ 2.2.3），无法使用云能力');
      return;
    }

    // config.cloudEnv 留空时不传 env —— 微信会使用小程序的「默认环境」，
    // 这样单云环境项目无需改任何代码即可运行。
    const initOptions = { traceUser: true };
    if (config.cloudEnv) {
      initOptions.env = config.cloudEnv;
    }
    wx.cloud.init(initOptions);
  },

  globalData: {},
});

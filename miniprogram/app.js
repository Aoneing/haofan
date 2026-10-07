// app.js — 好饭
const config = require('./config');
const openStats = require('./utils/openStats');

App({
  onLaunch() {
    // 打开频率统计：冷启动记一次（本地存储，不耗云资源）
    openStats.record();
    // 开始计时：退到后台（onHide）时结算这一次的停留时长，
    // 月历格子里显示的「1h41m」就是这么来的。
    this._openAt = Date.now();

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

  onShow() {
    // 从后台回到前台：重新起算本次停留
    this._openAt = Date.now();
  },

  onHide() {
    // 退到后台：把这一段停留分钟数记进今天
    if (this._openAt) {
      openStats.addMinutes((Date.now() - this._openAt) / 60000);
      this._openAt = 0;
    }
  },

  globalData: {},
});

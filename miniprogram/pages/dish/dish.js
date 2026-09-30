// pages/dish/dish.js — 单品详情：全屏大图 + 做法 + AI 生成入口
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dishNav = require('../../utils/dishNav');
const layout = require('../../utils/layout');

// 轮询节奏：生图实测 30 秒～2 分钟+（模型波动大），前 90 秒每 3 秒一次，
// 之后降到每 10 秒一次，总上限 4 分钟。就算超时，图大概率也已落库，重进页面即可看到。
const POLL_INTERVAL_MS = 3000;
const POLL_INTERVAL_SLOW_MS = 10000;
const POLL_SLOW_AFTER_MS = 90000;
// 生图实测 30–180 秒（GLM-Image 官方口径），轮询窗口要盖住上限再留余量。
// 云函数单次的等待上限远小于此，所以才必须走「提交任务 + 轮询取结果」的异步模式。
const POLL_MAX_MS = 300000;

/**
 * 生成失败的信息里有没有「配额/钱」的味道。
 * 与云函数 selfcheck 的 isQuotaError 是同一套口径（两边各留一份，避免前端依赖云函数）。
 *
 * 之所以要在 toast 里就把它认出来：429/1113 这种错误码普通人看着就是一串乱码，
 * 而它的处置又完全不用改代码（充钱即可），值得单独说清楚。
 */
const QUOTA_WORDS = ['余额不足', '无可用资源包', '额度不足', '已用尽', '已到期', '资源包已过期'];
function isQuotaMsg(msg) {
  const s = String(msg || '');
  if (!s) return false;
  if (QUOTA_WORDS.some((w) => s.indexOf(w) >= 0)) return true;
  return /429/.test(s) && /quota|insufficient|balance/i.test(s);
}

Page({
  data: {
    key: '',
    title: '',
    recipe: '', // 做法：从 day 页跳转时带过来（长文本走 dishNav 中转，不进 url）
    url: '',
    // 全屏大图：宽度恒为满屏 750rpx，高度按屏幕比例算，保证下方做法露出一截
    heroW: 750,
    heroH: layout.HERO_FALLBACK_RPX,
    hasRecipe: false,
    generating: false,
    genTip: '',
    // 诊断面板
    diagOpen: false,
    diagLoading: false,
    diagVerdict: '',
    diagLines: [],
    diagHints: [],
    diagUrlLen: 0,
    diagUrlHead: '',
  },

  onLoad(options) {
    const key = decodeURIComponent(options.key || '');
    const title = decodeURIComponent(options.title || '') || key;
    // 做法优先取中转站（day 页跳转前 put 进来的，长度不受限）；
    // 取不到再看 url 上有没有带短的，两条路都没有就是这份食谱本来没写做法。
    const carried = dishNav.take(key) || {};
    const recipe = decodeURIComponent(options.recipe || '') || carried.recipe || '';

    // 全屏大图高度：拿不到窗口尺寸就用兜底值，不能让页面因为一次 API 失败就崩
    let heroH = layout.HERO_FALLBACK_RPX;
    try {
      const win = wx.getSystemInfoSync();
      heroH = layout.calcHeroHeight(win.windowWidth, win.windowHeight);
    } catch (e) {
      console.warn('[dish] 读窗口尺寸失败，用兜底图高：', e && e.message);
    }

    this.setData({
      key,
      title,
      recipe,
      hasRecipe: !!recipe,
      heroW: 750,
      heroH,
    });
    this._pollTimer = null;
    this._pollDeadline = 0;
    this._applied = false; // 同一轮只允许提示一次，避免「生成返回」与「轮询命中」重复弹窗
    this._imgErrs = 0; // 图片加载失败次数，供诊断面板显示
  },

  /**
   * 诊断面板：图不显示时点一下，把「前端拿到了什么」和「云端自检结论」一起摆出来。
   *
   * 加它的原因：这个故障连续误判两轮，每轮都要「猜 → 改 → 部署 → 再看」。
   * 与其继续猜，不如让用户自己点一下就看到结论，一步到位。
   */
  toggleDiag() {
    const open = !this.data.diagOpen;
    this.setData({ diagOpen: open });
    if (open) this._runDiag();
  },

  _runDiag() {
    const key = this.data.key;
    const url = this.data.url || '';
    // 前端这一半：立刻可知，不用等云端
    this.setData({
      diagLoading: true,
      diagVerdict: '',
      diagHints: [],
      diagUrlLen: url.length,
      diagUrlHead: url ? url.slice(0, 42) + '…' : '(空)',
      diagLines: [
        '缓存里链接：' + (url ? '有（' + url.length + ' 字符）' : '没有'),
        '图片加载失败次数：' + (this._imgErrs || 0),
        '临时链接 TTL：' + Math.round(imageStore.URL_TTL_MS / 60000) + ' 分钟',
      ],
    });

    // 云端那一半：真下载一次换出的链接，看状态码
    api
      .image('selfcheck', { key })
      .then((res) => {
        const rep = res && res.report;
        if (!rep) {
          this.setData({ diagLoading: false, diagVerdict: '自检无返回（云端可能还是旧版本）' });
          return;
        }
        const lines = (rep.steps || []).map((s) => s.name + '：' + s.detail);
        const r0 = (rep.results || [])[0];
        if (r0) {
          lines.push('DB 记录：status=' + (r0.status || '?') + ' bytes=' + (r0.bytes || '?'));
          // 只在真的探测过时才显示 HTTP 结果：没探测过就显示 undefined 会误导
          if (typeof r0.httpStatus === 'number') {
            lines.push('HTTPS 实测：' + (r0.httpErr ? 'ERR ' + r0.httpErr : 'HTTP ' + r0.httpStatus));
          } else if (r0.step) {
            lines.push('当前阶段：' + r0.step);
          }
        }
        // ASCII 对照结果是判断「存储链路是否健康」的关键，单独突出
        if (rep.asciiProbe) {
          const ap = rep.asciiProbe;
          lines.push(
            '★ 存储链路对照（纯 ASCII 探针）：' +
              (ap.err ? 'ERR ' + ap.err : 'HTTP ' + ap.status) +
              (ap.status === 200 ? ' ⇒ 权限/链接/域名都正常' : ' ⇒ 存储链路有问题')
          );
        }
        this.setData({
          diagLoading: false,
          diagVerdict: rep.verdict || '—',
          diagLines: lines,
          diagHints: rep.hints || [],
        });
      })
      .catch((e) => {
        this.setData({
          diagLoading: false,
          diagVerdict: '自检调用失败：' + ((e && e.message) || '未知'),
          diagHints: ['多半是云函数还没部署新版本（selfcheck 是新增的 action）'],
        });
      });
  },

  /** 复制诊断文本，方便直接贴给我 */
  copyDiag() {
    const text = [
      '【好饭 · 配图诊断】',
      '菜名：' + this.data.key,
      '结论：' + this.data.diagVerdict,
      'url 长度：' + this.data.diagUrlLen,
      'url 前缀：' + this.data.diagUrlHead,
    ]
      .concat(this.data.diagLines || [])
      .concat((this.data.diagHints || []).map((h) => '· ' + h))
      .join('\n');
    wx.setClipboardData({ data: text });
  },

  onShow() {
    const key = this.data.key;
    if (!key) return;
    // 先用「仍然新鲜」的缓存链接立即渲染。注意用 getFresh 而不是 get：
    // 临时链接过期后不能再拿去喂 <image>，否则直接 403 灰底空白（这正是图区空白的老问题）。
    // getFresh 只返回 TTL 内的链接；过期就返回空，让下面的 hydrate 去换新的。
    const cached = imageStore.getFresh(key);
    if (cached) this.setData({ url: cached });

    // 先别急着自己在这里 resolve —— onHide 时会把 generating 抹掉（页面藏起来就该停），
    // 所以**重新进来第一件事是问一句「这道菜还在生成吗」**，还在就自动接着等。
    // 以前没这一步，用户退出再进来看到的是「什么都没发生」，只能再点一次生成，
    // 于是又担心是不是重复消耗了资源包的次数。
    this._resumeIfGenerating(key);
  },

  /**
   * 重进页面时：如果这道菜还有任务在跑，就恢复「生成中」的界面并继续轮询。
   *
   * 两个分支的区别：
   *  · 本地 generating 仍为 true —— 同一页面实例只是被别的页面盖住了，继续用原来的计时；
   *  · 服务端 states 显示 pending/saving —— 任务 migration 过了页面生命周期，
   *    本地状态已丢（典型：退出到外卖 trainees 再回来），必须靠服务端把它拉回来。
   */
  _resumeIfGenerating(key) {
    imageStore.refreshState(key).then((st) => {
      const busy = st === 'pending' || st === 'saving';
      if (busy && !this.data.generating) {
        this.setData({
          generating: true,
          genTip: '这道菜还在生成中，已自动继续等待…',
        });
        this._applied = false;
        this._startPoll(key);
        return;
      }
      // 不忙的话，走老逻辑把图刷新一遍（换可能已过期的链接）
      this._refreshUrl(key);
    });
  },

  /** 只在后台刷一次链接：临时链接会过期，重进页面时顺手换一张新的 */
  _refreshUrl(key) {
    imageStore.hydrate([key]).then(() => {
      if (this.data.generating) return; // 正在生成时不要抢 UI
      const fresh = imageStore.getFresh(key);
      if (fresh && fresh !== this.data.url) this.setData({ url: fresh });
    });
  },

  onUnload() {
    // 页面销毁必须停表，否则定时器还会在后台继续发请求、调 setData
    this._stopPoll();
  },

  onHide() {
    // 页面藏起来就该停表。这里**刻意不清 generating 的语义**：服务端那张图还在生，
    // 只是界面不再转圈。重新回来时 onShow → _resumeIfGenerating 会问服务端接着恢复，
    // 这样既不会在后台空转请求，也不至于丢掉「还在生成」这件事。
    this._stopPoll();
    if (this.data.generating) this.setData({ generating: false, genTip: '' });
  },

  /** dish-thumb 加载失败上报：累计次数，诊断面板会显示 */
  onThumbError() {
    this._imgErrs = (this._imgErrs || 0) + 1;
    if (this.data.diagOpen) this._runDiag();
  },

  /** 复制做法：做法常在「边看边做」的场景里被抄走，长按/点一下就能复制最省事 */
  copyRecipe() {
    const text = this.data.recipe;
    if (!text) {
      wx.showToast({ title: '这份食谱没有记录做法', icon: 'none' });
      return;
    }
    wx.setClipboardData({ data: text });
  },

  preview() {
    if (this.data.url) {
      wx.previewImage({ urls: [this.data.url] });
    }
  },

  /**
   * AI 生成配图（异步 + 轮询）
   *
   * 为什么不能用 await：单张生图 30–180 秒（GLM-Image 官方口径），远超云函数执行超时上限。
   * 同步 await 会被**强杀** —— 云函数在等图时进程没了，既不写 ready 也不写 failed，
   * 数据库那条记录就永远停在 pending（表现为「一直转圈、退出重进也永远没图」，实测卡了 364 秒）。
   *
   * 正确姿势：
   *   1) generate 只提交异步任务，秒回（taskId 落库）
   *   2) 按 3 秒一次轮询 resolve({collect:true})，云函数每次顺手问一次「任务好了没」
   *   3) 任务 SUCCESS 的那一次轮询会把图下载+压缩+上传+落库，并返回 https 链接
   * 每一步的耗时都在云函数超时预算内，图一好就能看到，不必重进页面。
   */
  generate() {
    if (this.data.generating) return;
    const key = this.data.key;
    if (!key) {
      wx.showToast({ title: '缺少菜名，无法生成', icon: 'none' });
      return;
    }

    this.setData({
      generating: true,
      genTip: '已提交生成任务，通常需要 30～180 秒，可以先做别的事',
    });
    this._applied = false;

    // 发起生成，但不拿它的返回当结论：返回可能因为超时永远不来，也可能晚于轮询结果到达。
    // force：已经配过图时按钮是「换一张配图」，要真的重生成，否则云函数幂等会原样返回旧图。
    // recipe：把做法带上，云函数据此抽出「蒸/煎/烤」等线索词写进提示词 ——
    //   只给菜名时模型凭空捏形态（「贝贝南瓜发糕」就可能画成奶油蛋糕），带上做法才能贴近实物。
    api
      .image('generate', {
        key,
        title: this.data.title,
        recipe: this.data.recipe || '',
        force: !!this.data.url,
      })
      .then((res) => {
        if (res && res.ok && res.fileID) {
          // 返回里带的是 https 临时链接；万一没带，就交给下面的轮询去取
          if (res.url) this._applyImage(key, res.url, '配图已更新');
          return;
        }
        if (res && res.pending) {
          // 异步模式：任务已提交，云函数不再傻等生图，由轮询去取结果
          if (res.taskId) {
            console.log('[dish] async task submitted:', res.taskId);
            this.setData({ genTip: '已提交生成任务，通常需要 30～180 秒' });
          }
          // reused=true 是云函数明确告诉我们「这道菜已经有任务在跑了，我没再提交」。
          // 这句话必须显示给用户 —— 他最担心的就是重复点击会不会多扣次数。
          if (res.reused) {
            this.setData({
              genTip: '这道菜已在生成中，已自动接着等 —— 不会重复消耗次数',
            });
          }
          return; // 交给轮询
        }
        if (res && res.code === 'NOT_CONFIGURED') {
          this._stop('NOT_CONFIGURED');
          wx.showModal({ title: '还没配置生图服务', content: res.message, showCancel: false });
          return;
        }
        if (res && res.code === 'COOLDOWN') {
          this._fail(res.message);
          return;
        }
        // 配额类失败直接说人话：用户在 toast 里就能看懂「这不是 bug，是没钱了」，
        // 不用再去翻诊断面板。原文里的 429/1113 对普通人是一串乱码。
        if (res && isQuotaMsg(res.message)) {
          this._stop('fail');
          wx.showModal({
            title: '生图配额用完',
            content:
              (res.message || '') +
              '\n\n这不是功能故障：去服务商后台充值/买资源包后，直接再点一次就能继续，不用重新部署。',
            showCancel: false,
          });
          return;
        }
        this._fail((res && res.message) || '生成失败');
      })
      .catch((e) => {
        // 最常见的情况：调用被等待上限掐断。图可能马上就落库了，继续轮询即可
        console.warn('[dish] generate call interrupted, keep polling:', e && e.message);
      });

    // 同时也检查一下是不是「调用还没发出去、图其实已经在库里」（比如上次生成好了没显示）
    this._startPoll(key);
  },

  /** 轮询图库，直到拿到图或超过 POLL_MAX_MS。resolve 返回的是 https 临时链接。 */
  _startPoll(key) {
    this._stopPoll();
    this._pollDeadline = Date.now() + POLL_MAX_MS;

    const tick = () => {
      api
        // collect:true —— 让云函数顺手问一次「异步任务好了没」。
        // 生图 30–180 秒，超过云函数单次执行上限，只能这样分段取结果。
        .image('resolve', { keys: [key], collect: true })
        .then((res) => {
          const url = res && res.map ? res.map[key] : '';
          if (url) {
            this._applyImage(key, url, '配图已更新');
            return true; // 已拿到图，停轮
          }
          const state = res && res.states ? res.states[key] : '';
          if (state === 'failed') {
            // 不要把 message 写死成「请再点一次」：真因会存在 lastError 里（多半是接口 401/404/限流），
            // 写死了用户只会重复点，而重复点解决不了任何问题（2026-09-30 用户实际卡在这里）。
            this._fail('这次生成失败了');
            // 顺手把诊断面板刷新一遍，让 lastError 原文直接显示在页面上，省掉「再点一次诊断」
            this._diagDirty = true;
            return true; // 失败也停轮，别让用户干等
          }
          if (state === 'expired') {
            this._fail('这次任务超时了，请再点一次生成');
            return true;
          }
          return false;
        })
        .catch(() => false)
        .then((got) => {
          if (got || !this.data.generating) return;
          if (Date.now() >= this._pollDeadline) {
            this._stop('轮询超时');
            wx.showModal({
              title: '生成比预期慢',
              content:
                '已经等了 5 分钟还没拿到结果（生图通常 30～180 秒，偶尔更久）。\n\n最简单的确认方式：退出本页再进来——图已经好了就会直接显示；还是没有的话，再点一次生成即可。',
              showCancel: false,
            });
            return;
          }
          this._setTip();
          // 前段密轮询（3 秒），90 秒后转疏（10 秒）：生图大概率落库在 2 分钟后，省请求也不错过
          const elapsed = POLL_MAX_MS - (this._pollDeadline - Date.now());
          this._pollTimer = setTimeout(
            tick,
            elapsed < POLL_SLOW_AFTER_MS ? POLL_INTERVAL_MS : POLL_INTERVAL_SLOW_MS
          );
        });
    };

    tick();
  },

  /** 按已等待时长刷新提示文案，让用户知道没卡死 */
  _setTip() {
    if (!this.data.generating) return;
    const sec = Math.round((POLL_MAX_MS - (this._pollDeadline - Date.now())) / 1000);
    const tip =
      sec < 45
        ? 'AI 生成中，通常需要 30～180 秒，可以先做别的事'
        : '还在生成中，已等待 ' + sec + ' 秒…（中途退出也没关系，重进本页就能看到）';
    if (tip !== this.data.genTip) this.setData({ genTip: tip });
  },

  _applyImage(key, url, msg) {
    if (this._applied) return;
    this._applied = true;
    imageStore.set(key, url); // 写内存缓存，回列表/周视图立刻能复用
    this._stop('got image');
    this.setData({ url });
    wx.showToast({ title: msg, icon: 'success' });
  },

  _fail(message) {
    this._stop('fail');
    wx.showToast({ title: message, icon: 'none' });
  },

  _stop(why) {
    this._stopPoll();
    if (this.data.generating) {
      console.log('[dish] poll stopped:', why);
      this.setData({ generating: false, genTip: '' });
    }
    // 失败停在页面上时，面板里那句「结论」多半已经过时了（还写着「正在生成中」）。
    // 自动重跑一次自检，让用户看到的是最终真相，而不是一份中途快照。
    if ((why === 'fail' || why === '轮询超时') && this.data.diagOpen) this._runDiag();
  },

  _stopPoll() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  },
});

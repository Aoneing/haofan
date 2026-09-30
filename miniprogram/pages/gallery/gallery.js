// pages/gallery/gallery.js — 配图管理：每一张图的「账」都摊开给人看
//
// 为什么要这个页面（2026-09-30 用户原话）：
//   「我的里显示有 12 张配图了，我应该没有生成这么多，请检测」
//
// 这个疑问光靠口头解释解不掉 —— 用户需要**自己能看见**：
// 每个菜名旁边写着「提交 N 次」，N=1 就是一张图花一次，N=2 才说明有重复提交。
// 有了它，下次再怀疑就不用回来问，点开自己数。
//
// 顺带也让「图不对版」有了出口：删掉重生成一次，比解释半天管用。

const api = require('../../utils/api');

// 状态 → 展示文案与配色。用中文label而不是代号：这是给家人看的管理页，不是日志
const STATUS_TEXT = {
  ready: { label: '已就绪', cls: 'gal-badge--ok' },
  pending: { label: '生成中', cls: 'gal-badge--busy' },
  saving: { label: '入库中', cls: 'gal-badge--busy' },
  failed: { label: '失败', cls: 'gal-badge--bad' },
  none: { label: '无图', cls: 'gal-badge--idle' },
};

Page({
  data: {
    loading: true,
    items: [],
    totalGenerations: 0, // 所有菜的提交次数合计 —— 这就是「到底花了几次」的答案
    extraGenerations: 0, // 超出「一道菜一次」的部分，>0 才是真的重复扣了
    err: '',
    busyKey: '',
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true, err: '' });
    return api
      .image('list')
      .then((res) => {
        if (!res || !res.ok) {
          this.setData({ loading: false, err: (res && res.message) || '读取配图失败' });
          return;
        }
        const items = (res.items || []).map((it) => {
          const st = STATUS_TEXT[it.status] || STATUS_TEXT.none;
          return {
            key: it.key,
            title: it.title,
            url: it.url,
            hasImage: it.hasImage,
            status: it.status,
            statusLabel: st.label,
            statusCls: st.cls,
            bytesText: it.bytes ? Math.round(it.bytes / 1024) + 'KB' : '',
            submitCount: it.submitCount || 0,
            failCount: it.failCount || 0,
            lastError: it.lastError || '',
            timeText: it.generatedAt ? fmtDate(it.generatedAt) : '',
            // >1 才说明这一道菜被重复提交过，单独标出来让人一眼看到
            resubmitted: (it.submitCount || 0) > 1,
          };
        });

        const total = items.reduce((s, i) => s + i.submitCount, 0);
        // 「正常应该是一道菜一次」，多出来的就是非必要消耗
        const extra = items.reduce((s, i) => s + Math.max(0, i.submitCount - 1), 0);

        this.setData({
          loading: false,
          items,
          totalGenerations: total,
          extraGenerations: extra,
        });
      })
      .catch((e) => {
        this.setData({ loading: false, err: (e && e.message) || '读取配图失败' });
      });
  },

  preview(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.previewImage({ urls: [url] });
  },

  /**
   * 删掉一张配图：图明显不对版时用（绘画模型偶尔会把「XX发糕」画成别的糕点）。
   * 删的是记录 + 云存储文件，下次走到这道菜会重新生成，不会拿到缓存里的旧图。
   */
  remove(e) {
    const { key, title } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除这张配图？',
      content: '「' + title + '」的配图会被删掉，下次打开这道菜时可以重新生成。\n不会影响食谱和做法。',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ busyKey: key });
        api
          .image('remove', { key })
          .then((res) => {
            if (!res || !res.ok) {
              wx.showToast({ title: (res && res.message) || '删除失败', icon: 'none' });
              return;
            }
            wx.showToast({ title: '已删除', icon: 'success' });
            this.load();
          })
          .catch((err) => {
            wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
          })
          .then(() => this.setData({ busyKey: '' }));
      },
    });
  },
});

/** 毫秒 → YYYY-MM-DD HH:mm */
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

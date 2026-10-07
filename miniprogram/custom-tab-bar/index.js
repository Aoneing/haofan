// custom-tab-bar/index.js — 自绘底部导航
//
// 选中态同步约定：每个 tab 页在 onShow 里调用
//   this.getTabBar().setActive('/pages/today/today')
// 原生 tabBar 由框架管选中态，自绘之后就得自己管——漏调一次，
// 页面内容已经是「今日」，导航却还停在「一周」，是最容易出的错。

const TABS = [
  {
    path: '/pages/today/today',
    text: '今日',
    icon: '/images/tabbar/today.png',
    onIcon: '/images/tabbar/today-on.png',
  },
  {
    path: '/pages/week/week',
    text: '一周',
    icon: '/images/tabbar/week.png',
    onIcon: '/images/tabbar/week-on.png',
  },
  {
    path: '/pages/ingredient/ingredient',
    text: '食材',
    icon: '/images/tabbar/ingredient.png',
    onIcon: '/images/tabbar/ingredient-on.png',
  },
  {
    path: '/pages/mine/mine',
    text: '我的',
    icon: '/images/tabbar/mine.png',
    onIcon: '/images/tabbar/mine-on.png',
  },
];

Component({
  data: {
    list: TABS.map((t) => Object.assign({}, t, { active: false })),
  },

  methods: {
    /** 切到指定 tab */
    setActive(path) {
      const list = this.data.list.map((t) => Object.assign({}, t, { active: t.path === path }));
      this.setData({ list });
    },

    onTap(e) {
      const path = e.currentTarget.dataset.path;
      if (!path) return;
      // 已经在这个 tab 上就不再跳：wx.switchTab 到自身会白闪一下并触发无意义的 onShow
      const cur = this.data.list.find((t) => t.active);
      if (cur && cur.path === path) return;
      wx.switchTab({ url: path });
    },
  },
});
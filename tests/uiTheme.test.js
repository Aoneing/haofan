'use strict';

/**
 * UI 主题回归测试（2026-10-07 重构：按三张定稿图重塑视觉）
 *
 * 锁住重构后的「设计系统」不回退：
 *   · app.wxss 的核心配色 token（品牌紫 / 柠檬黄 / 浅紫 / 中紫 / 深墨绿 / 薄荷 / 浅灰 / 墨）
 *   · tabBar 走自绘（custom: true），三个 tab 的图标资源齐备
 *   · 三个主 tab 页各自在 onShow 里同步自绘导航选中态
 *   · 三个主 tab 页都用统一的 page-head 标题 + 品牌紫 hero 块（吉祥物）
 *   · 吉祥物 mascot 资源存在
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const APP_JSON = read('miniprogram/app.json');
const APP_WXSS = read('miniprogram/app.wxss');
const TB_JS = read('miniprogram/custom-tab-bar/index.js');
const TB_WXML = read('miniprogram/custom-tab-bar/index.wxml');
const TODAY_JS = read('miniprogram/pages/today/today.js');
const TODAY_WXML = read('miniprogram/pages/today/today.wxml');
const DT_JS = read('miniprogram/components/dish-tile/dish-tile.js');
const DT_WXML = read('miniprogram/components/dish-tile/dish-tile.wxml');
const WEEK_JS = read('miniprogram/pages/week/week.js');
const WEEK_WXML = read('miniprogram/pages/week/week.wxml');
const MINE_JS = read('miniprogram/pages/mine/mine.js');
const MINE_WXML = read('miniprogram/pages/mine/mine.wxml');
const INGREDIENT_JS = read('miniprogram/pages/ingredient/ingredient.js');
const INGREDIENT_WXML = read('miniprogram/pages/ingredient/ingredient.wxml');

const cases = [];
const t = (name, fn) => cases.push({ name, fn });

/* ---------- 1. 配色 token（取自定稿图像素采样） ---------- */

const TOKENS = [
  ['--brand', '#3b3aae'],   // 品牌紫（hero 卡）
  ['--lime', '#e9f94e'],    // 柠檬黄（强调）
  ['--violet-1', '#a9b6f2'],// 浅紫
  ['--violet-2', '#7c8cd8'],// 中紫
  ['--forest', '#1f3a3d'],  // 深墨绿
  ['--mint', '#7fe3c4'],    // 薄荷
  ['--mist', '#f2f2f4'],    // 浅灰底
  ['--ink', '#0e0e10'],     // 主文（墨）
];

TOKENS.forEach(([name, hex]) => {
  t('app.wxss：token ' + name + ' = ' + hex, () => {
    assert.ok(new RegExp(name + ':\\s*' + hex, 'i').test(APP_WXSS), '缺 ' + name + ' 或取值不是 ' + hex);
  });
});

/* ---------- 2. 自绘 tabBar ---------- */

t('app.json：tabBar 走自绘（custom: true）', () => {
  assert.ok(/"custom":\s*true/.test(APP_JSON), 'tabBar 必须是自绘，原生 tabBar 渲不出「选中=黑块+白图标」');
  const app = JSON.parse(APP_JSON);
  assert.strictEqual(app.tabBar.list.length, 4, '应为 4 个 tab（今日/一周/我的/食材）');
  const paths = app.tabBar.list.map((x) => x.pagePath);
  ['pages/today/today', 'pages/week/week', 'pages/mine/mine', 'pages/ingredient/ingredient'].forEach((p) => {
    assert.ok(paths.indexOf(p) >= 0, '缺少 tab：' + p);
  });
});

t('自绘导航：TABS 四项和 setActive 都在', () => {
  assert.ok(/const TABS = \[/.test(TB_JS), 'custom-tab-bar 应有 TABS 定义');
  assert.ok(/setActive/.test(TB_JS), '要有 setActive 同步选中态');
  assert.ok(/tb__item--on/.test(TB_WXML), '选中项要有高亮类');
  ['/pages/today/today', '/pages/week/week', '/pages/mine/mine', '/pages/ingredient/ingredient'].forEach((p) => {
    assert.ok(TB_JS.indexOf(p) >= 0, 'TABS 缺路径：' + p);
  });
});

t('app.json：tab 顺序为 今日/一周/食材/我的（食材与「我的」已交换）', () => {
  const app = JSON.parse(APP_JSON);
  const paths = app.tabBar.list.map((x) => x.pagePath);
  assert.deepStrictEqual(
    paths,
    ['pages/today/today', 'pages/week/week', 'pages/ingredient/ingredient', 'pages/mine/mine'],
    'tab 顺序应为 今日/一周/食材/我的'
  );
});

t('自绘导航：食材 tab 排在「我的」左侧（与 app.json 顺序一致）', () => {
  const iIng = TB_JS.indexOf("/pages/ingredient/ingredient'");
  const iMine = TB_JS.indexOf("/pages/mine/mine'");
  assert.ok(iIng >= 0 && iMine >= 0, 'TABS 应同时含食材与「我的」');
  assert.ok(iIng < iMine, '食材应排在「我的」左侧');
});

t('四个主 tab 页都在 onShow 同步自绘导航选中态', () => {
  assert.ok(/setActive\('\/pages\/today\/today'\)/.test(TODAY_JS), 'today 要 setActive');
  assert.ok(/setActive\('\/pages\/week\/week'\)/.test(WEEK_JS), 'week 要 setActive');
  assert.ok(/setActive\('\/pages\/mine\/mine'\)/.test(MINE_JS), 'mine 要 setActive');
  assert.ok(/setActive\('\/pages\/ingredient\/ingredient'\)/.test(INGREDIENT_JS), '食材页要 setActive');
});

/* ---------- 3. 统一骨架：page-head 标题 + 品牌紫 hero ---------- */

t('今日/一周/我的/食材 都用 page-head 标题', () => {
  assert.ok(/今日/.test(TODAY_WXML), 'today 缺 page-head 标题');
  assert.ok(/一周/.test(WEEK_WXML), 'week 缺 page-head 标题');
  assert.ok(/我的/.test(MINE_WXML), 'mine 缺 page-head 标题');
  assert.ok(/食材/.test(INGREDIENT_WXML), '食材页缺 page-head 标题');
});

t('今日页有品牌紫 hero 块（吉祥物）——我的页已改为深色配图管理卡', () => {
  assert.ok(/class="hero"/.test(TODAY_WXML), 'today 缺 hero 块');
  assert.ok(/hero__mascot/.test(TODAY_WXML), 'today 的 hero 缺吉祥物');
  assert.ok(/\/images\/mascot\.png/.test(TODAY_WXML), 'today 没引用 mascot 资源');
});

t('mine 配图管理卡：三层卡（底图渐变 + 错落文件卡 + 前景黑面板），整卡可点', () => {
  assert.ok(!/stat--lime/.test(MINE_WXML) && !/stat--mint/.test(MINE_WXML), '旧并列色块应已移除');
  assert.ok(!/hero__mascot/.test(MINE_WXML), '吉祥物应已从我的页移除');
  assert.ok(/class="gal-card"[^>]*bindtap="goGallery"/.test(MINE_WXML), '整卡可点进配图管理');
  // ① 底图 ② 内容（文件卡）③ 前景，参考图就是这三层
  assert.ok(/gal-card__base/.test(MINE_WXML), '要有底图层');
  assert.ok(/gal-card__docs/.test(MINE_WXML) && /gal-card__doc /.test(MINE_WXML), '要有内容层（文件卡）');
  assert.ok(/gal-card__doc--a/.test(MINE_WXML) && /gal-card__doc--b/.test(MINE_WXML) && /gal-card__doc--c/.test(MINE_WXML), '三张文件卡要错落（a/b/c 三个位置）');
  assert.ok(/gal-card__fg/.test(MINE_WXML), '要有前景面板');
  assert.ok(/gal-card__dots/.test(MINE_WXML), '前景要有 ··· 装饰');
  assert.ok(/gal-card__ico/.test(MINE_WXML), '前景底部要有文件图标');
  assert.ok(/\{\{dishTotal\}\}/.test(MINE_WXML) && /张配图/.test(MINE_WXML), '前景底部要显示配图数');
  // 内容层的图：遍历 recentImgs，且必须来自 dishImage list（云端已按时间倒序）
  assert.ok(/wx:for="\{\{recentImgs\}\}"/.test(MINE_WXML), '文件卡要遍历 recentImgs');
  assert.ok(/gal-card__docimg/.test(MINE_WXML), '文件卡面要显示图片');
  assert.ok(/api\.image\('list'/.test(MINE_JS), '要用 dishImage list 取最近生成的图');
  assert.ok(/GAL_PREVIEW = 3/.test(MINE_JS), '示例图数量用常量 GAL_PREVIEW 表达（当前 3 张）');
  assert.ok(/slice\(0, GAL_PREVIEW\)/.test(MINE_JS), '取最近三张示例图');
});

t('mine 配图管理卡：文件卡不能盖住前景标题（层叠上下文要闭合）', () => {
  // 文件卡带了 z-index:1/2，底图不给 z-index 就会让它逃出 overflow 裁剪、
  // 直接压在前景的「配图管理」标题上（曾出现标题被遮半截）。
  const MINE_WXSS = read('miniprogram/pages/mine/mine.wxss');
  const base = MINE_WXSS.match(/\.gal-card__base \{[\s\S]*?\}/);
  assert.ok(base, '底图样式要存在');
  assert.ok(/z-index:\s*0/.test(base[0]), '底图要有 z-index:0 自成层叠上下文，把文件卡关在里面');
  const fg = MINE_WXSS.match(/\.gal-card__fg \{[\s\S]*?\}/);
  assert.ok(fg && /z-index:\s*1/.test(fg[0]), '前景要 z-index:1 压在文件卡之上');
  // 前景高度受控：黑区不能拖成一大片空白（半卡高度有限，min-height 控制在 220rpx 内）
  const mh = (fg[0].match(/min-height:\s*(\d+)rpx/) || [])[1];
  assert.ok(mh && Number(mh) <= 220, '前景 min-height 须 ≤220rpx，否则黑区拖太长：' + mh);
});

t('mine 配图管理卡：深墨绿背景 + 标题垂直居中 + 三张示例图不越界', () => {
  const MINE_WXSS = read('miniprogram/pages/mine/mine.wxss');
  // ① 背景深墨绿（不是纯黑）：用户要求「比较深的墨绿色」
  const card = MINE_WXSS.match(/\.gal-card \{[\s\S]*?\}/);
  const fg = MINE_WXSS.match(/\.gal-card__fg \{[\s\S]*?\}/);
  assert.ok(card && /background:\s*#0d1f21/.test(card[0]), '卡身要用深墨绿 #0d1f21');
  assert.ok(fg && /background:\s*#0d1f21/.test(fg[0]), '前景面板也要深墨绿（与卡身连成一体）');
  assert.ok(!/#0b0b0e/.test(MINE_WXSS), '旧的纯黑 #0b0b0e 应已移除');

  // ② 标题垂直居中：head 用 flex:1 + items-center，底部张数行不再 margin-top:auto
  const head = MINE_WXSS.match(/\.gal-card__head \{[\s\S]*?\}/);
  assert.ok(head && /flex:\s*1/.test(head[0]), '标题区要 flex:1 才能占据中间弹性空间');
  assert.ok(head && /align-items:\s*center/.test(head[0]), '标题区要垂直居中');
  const foot = MINE_WXSS.match(/\.gal-card__foot \{[\s\S]*?\}/);
  assert.ok(foot && !/margin-top:\s*auto/.test(foot[0]), '底部张数行改由 flex-shrink 定位，不再靠 margin-top:auto 撑底');

  // ★「AI 菜品插图」与「N 张配图」并排一行（用户要求）：
  //   两者要同处一个 __row 容器（space-between 分居左右），不能是上下两个独立块。
  assert.ok(/class="gal-card__row"/.test(MINE_WXML), '要有 __row 容器把副标题与张数并成一行');
  const rowBlock = MINE_WXML.match(/<view class="gal-card__row">[\s\S]*?<\/view>\s*<\/view>/);
  assert.ok(rowBlock, '__row 要同时包含 sub 与 foot');
  assert.ok(/gal-card__sub/.test(rowBlock[0]) && /gal-card__foot/.test(rowBlock[0]), 'sub 与 foot 必须在同一个 __row 里');
  const row = MINE_WXSS.match(/\.gal-card__row \{[\s\S]*?\}/);
  assert.ok(row && /display:\s*flex/.test(row[0]), '__row 要 flex 布局');
  assert.ok(row && /justify-content:\s*space-between/.test(row[0]), '__row 要 space-between（左副标题、右张数）');
  assert.ok(row && /align-items:\s*center/.test(row[0]), '__row 要 align-items:center（同一基线）');
  // 副标题回到常规流（不再是 absolute 定位），否则没法与张数并排
  const sub = MINE_WXSS.match(/\.gal-card__sub \{[\s\S]*?\}/);
  assert.ok(sub && !/position:\s*absolute/.test(sub[0]), '副标题不能绝对定位，否则无法与张数并排');

  // ③ 三张示例图不能越出卡片右缘（叠放可以，但不能被裁掉大半）
  const innerW = 271; // 半卡内宽（约 291rpx 减去 padding）
  ['a', 'b', 'c'].forEach((k) => {
    const d = MINE_WXSS.match(new RegExp('\\.gal-card__doc--' + k + '\\s*\\{[^}]*}'));
    assert.ok(d, '要有 doc--' + k + ' 定位');
    const left = Number((d[0].match(/left:\s*(\d+)rpx/) || [])[1]);
    const doc = MINE_WXSS.match(/\.gal-card__doc \{[\s\S]*?width:\s*(\d+)rpx/);
    const w = Number(doc[1]);
    assert.ok(
      left + w <= innerW + 10,
      '第' + k + "张卡右缘(" + (left + w) + 'rpx)超出卡内宽(' + innerW + 'rpx)，会被裁掉'
    );
  });
});

t('mine：本月打开频率热力图（月历式，参考图风格）', () => {
  // 数据层：本地记录 + 月历网格 + 停留时长
  const OS_SRC = read('miniprogram/utils/openStats.js');
  assert.ok(/function record\(/.test(OS_SRC), 'openStats 要有 record() 记录打开');
  assert.ok(/function monthCalendar\(/.test(OS_SRC), '要有 monthCalendar() 出月历网格');
  assert.ok(/function addMinutes\(/.test(OS_SRC), '要有 addMinutes() 记录停留时长');
  assert.ok(/function fmtMinutes\(/.test(OS_SRC), '要有 fmtMinutes() 把分钟格式化成 1h41m');
  assert.ok(/levelOfMinutes/.test(OS_SRC), '色阶要按停留时长分档（参考图深浅=用得久不久）');
  assert.ok(/function shiftMonth\(/.test(OS_SRC), '要有 shiftMonth() 供月份切换');
  // 记录时机：app.onLaunch 记次数、onHide 结算时长
  const APP_SRC = read('miniprogram/app.js');
  assert.ok(/openStats\.record\(\)/.test(APP_SRC), 'app.onLaunch 要记录打开');
  assert.ok(/openStats\.addMinutes\(/.test(APP_SRC), 'app.onHide 要结算停留时长');
  assert.ok(/_openAt = Date\.now\(\)/.test(APP_SRC), '要有计时起点');

  // 展示层：月历表头 + 星期表头 + 日期格
  assert.ok(/class="heat"/.test(MINE_WXML), '我的页要有热力图卡片');
  assert.ok(/\{\{heatTitle\}\}/.test(MINE_WXML), '标题要显示年月（如 2026年10月）');
  assert.ok(/\{\{heatTotal\}\} 次/.test(MINE_WXML), '要显示本月打开次数');
  assert.ok(/WEEK_LABELS/.test(MINE_WXML), '星期表头要遍历 WEEK_LABELS（一..日）');
  assert.ok(/heat__wd/.test(MINE_WXML), '要有星期表头行');
  assert.ok(/heat__day/.test(MINE_WXML), '每格要显示日号');
  assert.ok(/c\.cls/.test(MINE_WXML), '日期格要直接用数据层算好的 c.cls');
  // 今天描边：class 由 openStats.monthCalendar 拼（cls 含 heat__cell--today），WXML 里不出现该字面量
  assert.ok(/heat__cell--today/.test(OS_SRC), 'openStats 要给今天的格子拼 heat__cell--today');
  // ★ 必须按「行」渲染：每行从左到右是 1,2,3,4...顺读。
  // 曾错按「列」渲染（遍历 heatCols），横向读出来是 5,6,7,1,2,3,4 —— 用户反馈「7 号过了是 1 号」。
  assert.ok(/wx:for="\{\{heatRows\}\}"/.test(MINE_WXML), '日期格要遍历 heatRows（按行）');
  // ★★ setData 的 key 必须与 wxml 绑定的字段名一致。
  // 实踩：wxml 遍历 heatRows，refreshHeat 却 setData({heatCols}) ⇒ 循环拿到 undefined，
  // 整个日期网格一片空白（只剩星期表头与图例），用户实机截图才发现。
  assert.ok(/heatRows:\s*cal\.rows/.test(MINE_JS), 'setData 要写 heatRows: cal.rows（与 wxml 的 wx:for 字段名一致）');
  assert.ok(!/heatCols:\s*cal\./.test(MINE_JS), '不要再 setData heatCols（wxml 已不绑这个字段）');
  assert.ok(/heatRows:\s*\[\]/.test(MINE_JS), 'data 里要初始化 heatRows');
  assert.ok(!/wx:for="\{\{heatCols\}\}"/.test(MINE_WXML), '不能再按列遍历（会乱序）');
  assert.ok(/heat__row/.test(MINE_WXML), '要有行容器');
  // 空位置要有同尺寸占位，否则该行会缺格、后面所有行整体错位
  // 空位置必须由数据层的占位对象承担（class={{c.cls}} 单元素渲染）。
  // ⚠️ 不能用 wx:if / wx:else 两个元素写空位：两者一旦被注释或空行隔断，
  // 整页就编译失败（Bad attr wx:else with message: wx:if not found）。2026-10-07 实踩。
  assert.ok(/class="heat__cell \{\{c\.cls\}\}"/.test(MINE_WXML), '日期格要用单一元素 + c.cls 渲染，不做 if/else 分支');
  assert.ok(/wx:else/.test(MINE_WXML), '本月热力图区不该再出现 wx:else（易被注释隔断）');
  assert.ok(/heat__l0/.test(MINE_WXML) && /heat__l4/.test(MINE_WXML), '图例要覆盖五档色阶');
  // 月份切换
  assert.ok(/bindtap="prevMonth"/.test(MINE_WXML) && /bindtap="nextMonth"/.test(MINE_WXML), '要有上/下月切换');
  assert.ok(/prevMonth\(\)/.test(MINE_JS) && /nextMonth\(\)/.test(MINE_JS), '要实现 prevMonth/nextMonth');
  assert.ok(/stepMonth/.test(MINE_JS), '月份切换要有统一入口');
  // 7 列星期表头必须是完整 7 天，少一天日期就会错位
  assert.ok(
    /WEEK_LABELS:\s*\[[^\]]*'一'[^\]]*'二'[^\]]*'三'[^\]]*'四'[^\]]*'五'[^\]]*'六'[^\]]*'日'/.test(MINE_JS),
    'WEEK_LABELS 必须是 一二三四五六日 共 7 项'
  );

  const MINE_WXSS = read('miniprogram/pages/mine/mine.wxss');
  [0, 1, 2, 3, 4].forEach((l) => {
    assert.ok(new RegExp('\\.heat__l' + l + '\\s*\\{[^}]*background').test(MINE_WXSS), '色阶 l' + l + ' 要有底色');
  });
  // 深色档必须反白字，否则深绿底上的黑字看不见
  assert.ok(/\.heat__l3 \.heat__day/.test(MINE_WXSS) && /\.heat__l4 \.heat__day/.test(MINE_WXSS), '深色档要反白字');
  assert.ok(/heat__cell--today/.test(MINE_WXSS), '今天标记要有样式');
});

t('★ 热力图色阶：亮度严格递减，且每档在白底上都看得见', () => {
  const MINE_WXSS = read('miniprogram/pages/mine/mine.wxss');
  const lum = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };
  // 每档对白底都要有可见对比。
  // 阈值演变（都是实机校准 + 用户反馈）：
  //   #eef1f4(差20) → 用户「看着还是白的，没颜色」⇒ 提到 28
  //   #dfe3e9(差28.5) → 用户「默认的灰色太灰了，可以浅灰一些」⇒ 放宽到 12
  // 现在最浅档差 15.3，既能看出是一格、又不再显得灰扑扑。
  // 空白格必须有底色：transparent 在白底卡上等于没渲染。
  // ⚠️ 正则要能匹配「选择器组」写法：月历里 blank 与 void 合并成 `.a,.b { }` 一条规则。
  const pick = (sel) => {
    const m = MINE_WXSS.match(new RegExp('\\.' + sel + '[^{}]*\\{[^}]*background:\\s*(#[0-9a-fA-F]{6})'));
    return m ? m[1] : '';
  };
  const blank = pick('heat__cell--blank');
  assert.ok(blank, '空白格必须给浅灰底色，不能是 transparent');
  // ≥12 是「看得见一格」的下限；再浅就退回成白底、整片像没渲染
  assert.ok(255 - lum(blank) >= 12, '空白格对白底亮度差须 ≥12（低于此等于白底没渲染）：' + blank);
  // 但也别太深 —— 上限 22 是用户「太灰了」反馈划的红线
  assert.ok(255 - lum(blank) <= 22, '空白格对白底亮度差须 ≤22（超过就太灰，用户反馈过）：' + blank);

  // 五档 + blank 串起来必须亮度严格递减（openStats.levelOf 是 0→4 递进）
  const order = ['heat__cell--blank', 'heat__l0', 'heat__l1', 'heat__l2', 'heat__l3', 'heat__l4'];
  const lums = order.map((s) => {
    const c = pick(s);
    assert.ok(c, s + ' 要有实色底');
    return lum(c);
  });
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      lums[i] < lums[i - 1],
      order[i] + '(' + lums[i].toFixed(1) + ') 必须比 ' + order[i - 1] + '(' + lums[i - 1].toFixed(1) + ') 浅'
    );
  }
  // 每档对白底都要有可见对比（≥12 亮度差），不能浅到在手机上看不见
  lums.forEach((L, i) => {
    assert.ok(255 - L >= 12, order[i] + ' 与白底对比太弱(差' + (255 - L).toFixed(1) + ')，实机上会看不见');
  });
  // 相邻档必须拉得开（≥6亮度差），否则两档肉眼看不出区别
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      lums[i - 1] - lums[i] >= 6,
      order[i - 1] + ' 与 ' + order[i] + ' 差太小(' + (lums[i - 1] - lums[i]).toFixed(1) + ')，两档分不开'
    );
  }
});

t('热力图月历：按行渲染 7 列等宽，格子够小以便和配图管理左右排列', () => {
  const MINE_WXSS = read('miniprogram/pages/mine/mine.wxss');
  // 行内 7 格等宽（.heat__cell flex:1），少一格该行就缺、后面所有行错位
  const cell = MINE_WXSS.match(/\.heat__cell \{[\s\S]*?\}/);
  assert.ok(cell && /flex:\s*1/.test(cell[0]), '日期格要 flex:1 等宽铺满');
  assert.ok(/min-width:\s*0/.test(cell[0]), '日期格要 min-width:0，否则 7 列会被内容撑破');
  // 行容器本身要 flex 布局 + 换行空间
  const row = MINE_WXSS.match(/\.heat__row \{[\s\S]*?\}/);
  assert.ok(row && /display:\s*flex/.test(row[0]), '行容器要 display:flex');
  assert.ok(/\.heat__grid \{[\s\S]*?flex-direction:\s*column/.test(MINE_WXSS), '网格要纵向排列各行');
  // ★ 表头、每行内部的 gap 必须一致，否则星期标题和日期列对不齐
  const gapOf = (sel) => {
    const m = MINE_WXSS.match(new RegExp('\\.' + sel + '\\s*\\{[^{}]*gap:\\s*(\\d+)rpx'));
    return m ? m[1] : '';
  };
  assert.ok(gapOf('heat__wd'), '星期表头要有 gap');
  assert.strictEqual(gapOf('heat__wd'), gapOf('heat__row'), '星期表头与日期行的 gap 必须一致（否则列对不齐）');
  // 格子必须小到能和配图管理并排（通栏会把月历拉得过大）
  const h = cell[0].match(/height:\s*(\d+)rpx/);
  assert.ok(h && Number(h[1]) <= 72, '格子高度须 ≤72rpx，超出就放不进半卡：' + (h && h[1]));
  // ★格子必须正方形：宽由 flex:1 均分（约 46rpx），高度取同值。
  // 曾height:68rpx 而宽约 46rpx，实机采样 47x68px 明显偏长，视觉上像「格子太高」。
  const cellGap = (MINE_WXSS.match(/\.heat__row \{[\s\S]*?gap:\s*(\d+)rpx/) || [])[1] || '4';
  const dashGap = (MINE_WXSS.match(/\.dash-row \{[\s\S]*?gap:\s*(\d+)rpx/) || [])[1] || '16';
  const heatFlex = (MINE_WXSS.match(/\.heat \{[\s\S]*?flex:\s*([\d.]+)/) || [])[1];
  const galFlex = (MINE_WXSS.match(/\.gal-card \{[\s\S]*?flex:\s*([\d.]+)/) || [])[1];
  const heatPad = (MINE_WXSS.match(/\.heat \{[\s\S]*?padding:\s*[\d.]+rpx ([\d.]+)rpx/) || [])[1];
  assert.ok(heatFlex && galFlex && heatPad, '要能读到布局参数才能验正方形');
  const contW = 750 - 64; // 页面左右 padding 各32
  const heatCardW = ((contW - Number(dashGap)) * Number(heatFlex)) / (Number(heatFlex) + Number(galFlex));
  const cellW = (heatCardW - Number(heatPad) * 2 - Number(cellGap) * 6) / 7;
  assert.ok(
    Math.abs(Number(h[1]) - cellW) <= 6,
    '格子高(' + h[1] + 'rpx)应≈宽(' + cellW.toFixed(1) + 'rpx) 才是正方形，偏差不能超过 6rpx'
  );
  assert.ok(/\.heat__day\s*\{/.test(MINE_WXSS), '要有日号样式');
  // 布局：一行两卡（热力图 + 配图管理）必须存在
  assert.ok(/\.dash-row \{[\s\S]*?display:\s*flex/.test(MINE_WXSS), '要保留 dash-row 一行两卡布局');
  assert.ok(/\.heat \{[\s\S]*?flex:\s*1/.test(MINE_WXSS), '热力图要在 dash-row 里占一份');
  assert.ok(/\.gal-card \{[\s\S]*?flex:\s*1/.test(MINE_WXSS), '配图管理要在 dash-row 里占一份');
  // 已删除的旧结构不得残留
  assert.ok(!/heat__weeks/.test(MINE_WXSS), '旧的周历网格样式应已移除');
  assert.ok(!/heat__labels/.test(MINE_WXSS), '旧的星期标签列样式应已移除');
  assert.ok(!/\.heat__col\s*\{/.test(MINE_WXSS), '旧的按列样式应已移除（现在按行）');
  assert.ok(!/heat__time/.test(MINE_WXSS), '缩小后不再显示时长文本');
});

t('★ monthCalendar 必须按日历真实位置逐日落位（横读1,2,3... 递增）', () => {
  // 曾经的 bug：先按星期分桶再转置，横向读出来是 5,6,7,1,2,3,4（用户反馈「7 号过了是 1 号」）。
  // 这里真的跑数据层（注入假 wx），逐月验证顺读递增 + 日期数正确 + 每行 7 格。
  const stubWx = { getStorageSync: () => ({}), setStorageSync: () => {} };
  const sandbox = { module: { exports: {} }, exports: {}, wx: stubWx, console: console };
  const src = read('miniprogram/utils/openStats.js');
  new Function('module', 'exports', 'wx', 'console', src)(sandbox.module, sandbox.exports, stubWx, console);
  const os = sandbox.module.exports;
  assert.strictEqual(typeof os.monthCalendar, 'function', 'monthCalendar 要可调用');

  [[2026, 9, 7], [2026, 6, 18], [2026, 1, 15], [2026, 11, 31], [2026, 7, 31], [2026, 2, 3]].forEach(([y, mo, day]) => {
    const today = new Date(y, mo, day);
    const cal = os.monthCalendar(today, y, mo);
    const dim = new Date(y, mo + 1, 0).getDate();
    const seq = cal.rows.flat().filter((c) => c && !c.void).map((c) => c.d);
    // 1) 日期数 = 当月天数
    assert.strictEqual(seq.length, dim, y + '年' + (mo + 1) + '月应有' + dim + '天，实际 ' + seq.length);
    // 2) 横读必须严格递增（这正是用户报的乱序问题）
    const sorted = seq.slice().sort((a, b) => a - b);
    assert.strictEqual(
      seq.join(','),
      sorted.join(','),
      y + '年' + (mo + 1) + '月横读顺序错乱：' + seq.join(',') + '（应递增）'
    );
    // 3) 每行恒 7 格
    cal.rows.forEach((r, i) => {
      assert.strictEqual(r.length, 7, y + '年' + (mo + 1) + '月第' + (i + 1) + '行不是 7 格：' + r.length);
    });
    // 4) 1 号落在正确的星期列（lead = (getDay+6)%7）
    //空位是 void 占位对象（不是 null：null 在 WXML 取不到属性，就得靠 wx:if/wx:else 分支，
    //    而 wx:else 被注释隔断会直接编译失败）
    const lead = (new Date(y, mo, 1).getDay() + 6) % 7;
    const firstRow = cal.rows[0];
    for (let c = 0; c < lead; c++) {
      assert.ok(firstRow[c] && firstRow[c].void, y + '年' + (mo + 1) + '月 1 号前第' + (c + 1) + '格应是 void 占位');
    }
    assert.ok(firstRow[lead] && !firstRow[lead].void && firstRow[lead].d === 1, '1 号应在第' + (lead + 1) + '列');
    // 占位对象必须带 cls，WXML 才能只写 class="{{c.cls}}"（单元素、无分支）
    cal.rows.flat().filter((c) => c && c.void).forEach((c) => {
      assert.strictEqual(c.cls, 'heat__cell--void', 'void 占位格要带 heat__cell--void class');
    });
    // 5) 今天标记：只有正在查看的月份就是「注入的参考时刻」所在月才该出现，且唯一。
    //    注意 isToday 是按monthCalendar 传入的参考时刻算的，不是系统当前时间。
    const isCur = y === today.getFullYear() && mo === today.getMonth();
    const todayCells = cal.rows.flat().filter((c) => c && c.isToday);
    assert.strictEqual(todayCells.length, isCur ? 1 : 0, y + '年' + (mo + 1) + '月今天标记数量不对');
    if (isCur) {
      assert.strictEqual(todayCells[0].d, today.getDate(), '今天标记应指向参考时刻的今天 ' + today.getDate());
    }
    // 6) 参考时刻之后的日期必须是未来日（level=-1 不着色）
    cal.rows.flat().filter((c) => c && !c.void).forEach((c) => {
      if (c.d > today.getDate() && isCur) assert.strictEqual(c.level, -1, c.d + ' 号还没到，应为 -1（不着色）');
      if (c.d <= today.getDate() && isCur) assert.ok(c.level >= 0, c.d + ' 号已过，不应是 -1');
    });
  });
});

t('week 与 食材 页不渲染 hero（用户要求去掉，选中日/板块提示走 sec-head）', () => {
  assert.ok(!/class="hero"/.test(WEEK_WXML), 'week 不应再有 hero 块');
  assert.ok(!/class="hero"/.test(INGREDIENT_WXML), '食材页不应再有 hero 块');
  assert.ok(/sec-head__title/.test(WEEK_WXML), 'week 要保留 sec-head 标题显示选中日期');
  // 「今天」标记并入标题：activeDateText 拼接 · 今天
  assert.ok(/· 今天/.test(WEEK_JS), 'week.js 应把「今天」并进 activeDateText');
});

/* ---------- 4. 菜品色卡必须标注餐次（早餐/午餐/晚餐/加餐） ---------- */

t('dish-tile：vm 带上餐次中文标签', () => {
  assert.ok(/mealLabel/.test(DT_JS), 'dish-tile.js 应调用 mealLabel 取餐次文案');
  assert.ok(/mealLabel:\s*mealLabel/.test(DT_JS), 'vm 必须含 mealLabel 字段');
});

t('dish-tile：餐次标签渲染在卡上（dt__meal 胶囊）', () => {
  assert.ok(/class="dt__meal/.test(DT_WXML), 'wxml 要有 dt__meal 标签元素');
  assert.ok(/\{\{vm\.mealLabel\}\}/.test(DT_WXML), 'dt__meal 要绑定 vm.mealLabel');
});

t('dish-tile：直接在卡上显示 AI 插图，且底边渐融入卡片', () => {
  assert.ok(/class="dt__media"/.test(DT_WXML) && /class="dt__img"/.test(DT_WXML), '要有插图容器与 image');
  assert.ok(/\{\{vm\.image\}\}/.test(DT_WXML), 'image 要绑定 vm.image');
  // 渐变条：从透明过渡到卡片底色（vm.bg），把插图下边缘化进卡片
  assert.ok(/dt__fade/.test(DT_WXML) && /linear-gradient\(to bottom, rgba\(255,255,255,0\), \{\{vm\.bg\}\}\)/.test(DT_WXML), '要有渐变融入卡片底色的 fade 层');
  assert.ok(/imageStore/.test(DT_JS), 'dish-tile 应直接取 imageStore 的图');
  assert.ok(/getFresh\(key\)/.test(DT_JS), '要取新鲜链接（避免过期死链）');
});

t('dish-tile：热量/用时小字压在卡片底部', () => {
  assert.ok(/class="dt__foot"/.test(DT_WXML), '要有底部小字行 dt__foot');
  assert.ok(/\{\{vm\.kcalText\}\}/.test(DT_WXML) && /\{\{vm\.minutesText\}\}/.test(DT_WXML), '底部要同时显示热量与用时');
});

t('const.mealLabel：四个餐次映射到中文', () => {
  const c = require('../miniprogram/utils/const');
  assert.strictEqual(c.mealLabel('breakfast'), '早餐');
  assert.strictEqual(c.mealLabel('lunch'), '午餐');
  assert.strictEqual(c.mealLabel('snack'), '加餐');
  assert.strictEqual(c.mealLabel('dinner'), '晚餐');
});

/* ---------- 5. 资源齐备 ---------- */

[
  'miniprogram/images/mascot.png',
  'miniprogram/images/tabbar/today.png', 'miniprogram/images/tabbar/today-on.png',
  'miniprogram/images/tabbar/week.png', 'miniprogram/images/tabbar/week-on.png',
  'miniprogram/images/tabbar/mine.png', 'miniprogram/images/tabbar/mine-on.png',
  'miniprogram/images/tabbar/ingredient.png', 'miniprogram/images/tabbar/ingredient-on.png',
].forEach((p) => {
  t('资源存在：' + p, () => {
    assert.ok(exists(p), '缺资源：' + p + '（跑 node scripts/assets/gen-assets.js 生成）');
  });
});

t('★ 全项目 wxml：wx:else 必须紧邻 wx:if/wx:elif（否则整页编译失败）', () => {
  // 实踩：mine.wxml 里 <view wx:if="{{c}}"> 与 <view wx:else> 之间夹了一行注释，
  // 编译报 Bad attr wx:else with message: wx:if not found，整个「我的」页白屏。
  // 这里做真实标签栈解析（含自闭合节点），扫描所有 .wxml。
  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir).forEach((f) => {
      const p = path.join(ROOT, dir, f);
      if (fs.statSync(p).isDirectory()) walk(path.join(dir, f));
      else if (f.endsWith('.wxml')) files.push(path.join(dir, f));
    });
  })('miniprogram');
  assert.ok(files.length > 5, '要扫到多个 wxml，实际 ' + files.length);

  const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/gs;
  const problems = [];
  files.forEach((rel) => {
    // ⚠️ 不剥注释：微信编译器**不过滤注释**，注释夹在 wx:if 与 wx:else 之间
    //    就算隔断（实踩：mine.wxml 整页编译失败 Bad attr wx:else / wx:if not found）。
    //    必须在原始文本上判断相邻性；「是否被隔断」通过查两节点之间有无注释来判定。
    //    （曾经先剥注释再判断，等于替编译器做了它不会做的事，扫描器就抓不到这个 bug 了。）
    const src = read(rel.split(path.sep).join('/'));
    const raw = [];
    const stack = [];
    tagRe.lastIndex = 0;
    let m;
    while ((m = tagRe.exec(src))) {
      const closing = m[1];
      const attrs = m[3];
      const selfClose = m[4];
      if (closing) {
        if (stack.length) {
          const st = stack.pop();
          raw.push([st[0], m.index, st[1], st[2]]);
        }
      } else if (selfClose) {
        // 自闭合标签的 end 要算到标签结束（m.index + 标签长度），
        // 否则「前一个兄弟到wx:else 之间的文本」会把整个自闭合标签本身截进去，
        // 被误判成「中间夹了别的元素」。
        raw.push([m.index, m.index + m[0].length, attrs, stack.length]);
      } else {
        raw.push([m.index, m.index, attrs, stack.length]);
        stack.push([m.index, attrs, stack.length]);
      }
    }
    // ⚠️ 容器元素被 push 了两次（开标签一次、闭合时补end 一次），start 相同。
    //    必须按 start+attrs 合并、并取 end 的最大值，否则自闭合标签的
    //    「伪记录」会盖掉真正的容器记录，误判成 wx:else 没有配对 wx:if。
    const merged = new Map();
    raw.forEach((n) => {
      const k = n[0] + '|' + n[2];
      if (merged.has(k)) merged.get(k)[1] = Math.max(merged.get(k)[1], n[1]);
      else merged.set(k, [n[0], n[1], n[2], n[3]]);
    });
    const sib = [...merged.values()].sort((a, b) => a[0] - b[0]);

    sib.forEach((e, i) => {
      if (!/(^|\s)wx:else(\s|=|$)/.test(e[2])) return;
      // 找同层级、且在它之前结束的最近兄弟
      let prev = null;
      for (let k = 0; k < i; k++) if (sib[k][3] === e[3] && sib[k][1] <= e[0]) prev = sib[k];
      const paired = prev && /(^|\s)wx:(if|elif)(\s|=)/.test(prev[2]);
      // 即便前一个兄弟带了 wx:if，中间夹了注释或别的东西也算隔断
      const between = prev ? src.slice(prev[1], e[0]) : '';
      const gapBad = !paired || /<!--/.test(between) || /<[a-zA-Z]/.test(between);
      if (gapBad) {
        const line = src.slice(0, e[0]).split('\n').length;
        const why = !paired
          ? '前一个兄弟没有 wx:if/wx:elif'
          : /<!--/.test(between)
            ? 'wx:if 与 wx:else 之间夹了注释'
            : 'wx:if 与 wx:else 之间夹了别的元素';
        problems.push(path.basename(rel) + ':' + line + ' 「' + e[2].trim().slice(0, 40) + '」' + why);
      }
    });
  });
  assert.strictEqual(problems.length, 0, '以下 wx:else 缺少配对 wx:if，会导致整页编译失败：\n  ' + problems.join('\n  '));
});

// ---------- 食材页：新增「食材分析」子模块（在食材处理之前） ----------
t(' 食材页：导入分析工具 + 本地统计模块', () => {
  assert.ok(/require\('\.\.\/\.\.\/utils\/ingredientStats'\)/.test(INGREDIENT_JS), '要引入 ingredientStats');
  assert.ok(/require\('\.\.\/\.\.\/utils\/api'\)/.test(INGREDIENT_JS), '要引入 api 才能拉本周');
});

t(' 食材页：onShow 主动拉最近 3 周并算分析', () => {
  assert.ok(/loadAnalysis/.test(INGREDIENT_JS), '要有 loadAnalysis');
  assert.ok(/api\s*\n?\s*\.query\('getRecentWeeks'/.test(INGREDIENT_JS), 'loadAnalysis 必须调 getRecentWeeks（单云调用取最近 N 周，比循环 getWeek 省资源）');
  assert.ok(/weeks:\s*3/.test(INGREDIENT_JS), '要请求最近 3 周');
  assert.ok(/analyzeWeek\(/.test(INGREDIENT_JS), '要用 analyzeWeek 按周算占比');
  // onShow 里要触发（自绘 tabBar 同步 + 拉分析，二者都在 onShow）
  assert.ok(/onShow\(\)\s*\{[\s\S]*loadAnalysis\(\)/.test(INGREDIENT_JS), 'onShow 必须调用 loadAnalysis');
});

t(' 食材页：WXML 渲染食材分析（叠压周卡 + 堆叠条 + 图例 + 种类数）', () => {
  assert.ok(/ana-week__num/.test(INGREDIENT_WXML), '要有种类数大数字');
  assert.ok(/ana-bar__seg/.test(INGREDIENT_WXML), '要有占比堆叠条分段');
  assert.ok(/ana-legend/.test(INGREDIENT_WXML), '要有分类图例');
  assert.ok(/ana-legend__items/.test(INGREDIENT_WXML), '图例下要有实际食材小字容器（ana-legend__items）');
  assert.ok(/leg\.items/.test(INGREDIENT_WXML), '每个类别要渲染实际食材明细（{{leg.items}}）');
  // 与「食材处理」同族的叠压卡：ana-stack 容器 + ana-week 卡 + 马卡龙色轮转类
  assert.ok(/ana-stack/.test(INGREDIENT_WXML), '要用 ana-stack 叠压容器');
  assert.ok(/ana-week--t\{\{/.test(INGREDIENT_WXML), '周卡要用马卡龙色轮转类（ana-week--t{{index % 3}}）');
  assert.ok(/ana-week__name/.test(INGREDIENT_WXML), '卡头要有相对周标签（最近一周/两周前/三周前）');
  // 失败/空数据要兜底，不能白屏
  assert.ok(/ana-empty/.test(INGREDIENT_WXML), '要有空/失败兜底文案');
});

t(' 食材页：食材分析排在食材处理之前', () => {
  // 用标签内文本 `>食材X<` 精确匹配，避开顶部注释「食材处理手册」里的「食材处理」子串
  const iAna = INGREDIENT_WXML.indexOf('>食材分析<');
  const iPrep = INGREDIENT_WXML.indexOf('>食材处理<');
  assert.ok(iAna >= 0 && iPrep >= 0, '两个区块标题都要有');
  assert.ok(iAna < iPrep, '食材分析（新增）必须排在食材处理之前，实际 ana=' + iAna + ' prep=' + iPrep);
});

t(' 食材页：食材分析叠压卡可点击展开 + 叠压更多', () => {
  assert.ok(/anaOpenIndex/.test(INGREDIENT_JS), 'js 要有 anaOpenIndex 控制展开态');
  assert.ok(/toggleAna/.test(INGREDIENT_JS), '要有 toggleAna 切换展开/收起');
  assert.ok(/bindtap="toggleAna"/.test(INGREDIENT_WXML), '卡头要点一下展开（bindtap=toggleAna）');
  assert.ok(/ana-week--open/.test(INGREDIENT_WXML), '展开那张要有 ana-week--open 类（提到最上层）');
  assert.ok(/ana-week__go/.test(INGREDIENT_WXML), '卡头要有黑色圆形箭头指示可展开');
  assert.ok(/ana-week__more/.test(INGREDIENT_WXML), '展开后才显示「更多信息」（占比条+图例）容器');
  // 默认收起只露卡头，展开态用 wx:if 包住更多信息
  assert.ok(/wx:if="\{\{anaOpenIndex === index\}\}"/.test(INGREDIENT_WXML), '占比明细要随展开态显隐（wx:if）');
  // 叠压与食材处理一致（-18rpx），展开时内容完整可见、不被下一张盖住
  const ss = read('miniprogram/pages/ingredient/ingredient.wxss');
  assert.ok(/\.ana-stack\s+\.ana-week\s*\+\s*\.ana-week\s*\{\s*margin-top:\s*-18rpx;/.test(ss), '叠压要与食材处理一致（-18rpx）');
  assert.ok(/\.ana-week--open\s*\{\s*z-index:\s*10;/.test(ss), '展开卡要抬到最上层，免被下一张盖住内容');
});

// ---------- 云函数 menuQuery：getRecentWeeks 契约（文本断言，无法本地 require wx-server-sdk） ----------
const MENU_QUERY_JS = read('cloudfunctions/menuQuery/index.js');
t(' 云函数 menuQuery：新增 getRecentWeeks action（最近 N 周，单云调用）', () => {
  assert.ok(/case\s+'getRecentWeeks'/.test(MENU_QUERY_JS), 'switch 里要注册 getRecentWeeks action');
  assert.ok(/async function getRecentWeeks/.test(MENU_QUERY_JS), '要有 getRecentWeeks 实现');
  // 关键：按 startDate 倒序取「最近」N 周，且 limit 受控（免费档省资源）
  assert.ok(/orderBy\('startDate',\s*'desc'\)/.test(MENU_QUERY_JS), '要按 startDate 倒序取最近周期');
  assert.ok(/Math\.min\(Math\.max\(Number\(event\.weeks\)\s*\|\|\s*3,\s*1\),\s*8\)/.test(MENU_QUERY_JS), '周数默认 3、上限 8');
  assert.ok(/return\s*\{\s*ok:\s*true,\s*weeks:\s*out\s*\}/.test(MENU_QUERY_JS), '要返回 { ok, weeks:[{period,days}] }');
  // 食材分析只读 displayTitle，云端只投影最小字段，别把 21 天的 recipe/rawText/dishKeys 全量回传
  assert.ok(/meals:\s*\(d\.meals\s*\|\|\s*\[\]\)\.map\(\(m\)\s*=>\s*\(\{\s*displayTitle:\s*m\.displayTitle/.test(MENU_QUERY_JS), 'days 只回 {date, meals:[{displayTitle}]}，云端瘦身');
});

// ---------- utils/api：60s 读缓存（消除切 tab 的「冷启动感」） ----------
const API_JS = read('miniprogram/utils/api.js');
t(' utils/api：只读 action 走 60s 内存缓存，变更类清缓存', () => {
  assert.ok(/READ_TTL\s*=\s*60\s*\*\s*1000/.test(API_JS), '要有 60s TTL 常量');
  assert.ok(/const\s+_cache\s*=\s*new\s+Map\(\)/.test(API_JS), '要有模块级缓存 Map');
  // 只读 action 默认缓存：getContext/getWeek/listPeriods/getRecentWeeks + dishImage 的 stats/list
  assert.ok(/MENU_QUERY_READ\s*=/.test(API_JS), '要声明可缓存的 menuQuery action 清单');
  assert.ok(/DISH_IMAGE_READ\s*=/.test(API_JS), '要声明可缓存的 dishImage action 清单');
  // save / parse（变更类）成功后必须清缓存，保证写后读一致
  assert.ok(/\.then\(\(r\)\s*=>\s*\{\s*_cache\.clear\(\)/.test(API_JS), 'save/parse 成功后要 _cache.clear()');
  // 轮询/写类（resolve/generate）不能缓存：query/image 默认对未声明 action 不开缓存
  assert.ok(/cacheable\s*&&\s*!\(opts\s*&&\s*opts\.noCache\)/.test(API_JS), '只有清单内的只读 action 才默认缓存');
  assert.ok(/clearCache\(\)/.test(API_JS), '要暴露 api.clearCache() 供特殊场景手动清');
});

// ---------- 切 tab 静默刷新（消除「冷启动感」） ----------
t(' 首页/一周/我的：onShow 首次全量、之后静默刷新不闪空白', () => {
  const TODAY_JS = read('miniprogram/pages/today/today.js');
  const WEEK_JS = read('miniprogram/pages/week/week.js');
  const MINE_JS = read('miniprogram/pages/mine/mine.js');
  // 三个页都要用 _inited 标记「是否已首加载」，之后走 load(true) 静默刷新
  [TODAY_JS, WEEK_JS, MINE_JS].forEach((src, i) => {
    const name = ['today', 'week', 'mine'][i];
    assert.ok(/this\._inited/.test(src), name + ' 要用 _inited 区分首次/切回');
    assert.ok(/load\([^)]*true\)/.test(src), name + ' 切回要 load(.., true) 静默刷新');
  });
  // 静默刷新必须保留各自展开态
  assert.ok(/expandedUid:\s*silent\s*\?\s*this\.data\.expandedUid/.test(TODAY_JS), 'today 静默刷新要保留展开的色卡(expandedUid)');
  assert.ok(/applyActive\([^)]*silent\)/.test(WEEK_JS) && /preserveExpand/.test(WEEK_JS), 'week 静默刷新要把 silent 透传给 applyActive 以保留展开态');
  assert.ok(/periodExpanded:\s*silent\s*\?\s*this\.data\.periodExpanded/.test(MINE_JS), 'mine 静默刷新要保留历史周期展开态(periodExpanded)');
});

module.exports = cases;

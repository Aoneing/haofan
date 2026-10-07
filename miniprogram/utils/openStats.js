// utils/openStats.js — 「打开小程序」频率与时长的本地记录 + 月历热力图数据
//
// 为什么放本地存储而不进云数据库：
//   · 这是对「这台设备上的我」的统计，不跨设备同步，云端没必要为此建集合；
//   · 免费档云开发资源金贵，能用本地就不上云。
// 记录时机：
//   · record()——app.onLaunch（冷启动 = 打开了一次）
//   · addMinutes()——app.onHide（退到后台时结算这一次的停留时长）
//
// 数据结构（storage 里一条记录）：
//   { 'YYYY-MM-DD': { c: 打开次数, m: 累计分钟 } }
//   c 决定热力色阶，m 显示成「1h41m」这样的时长文本。
const KEY = 'haofan_open_stats';
// 只保留最近 92 天：月历要能往前翻两个月，62 天不够
const KEEP_DAYS = 92;

/** 当天打开次数 +1（存储异常时静默放弃，绝不影响主流程） */
function record() {
  try {
    const stats = wx.getStorageSync(KEY) || {};
    const k = dayKey(new Date());
    const row = stats[k] || {};
    row.c = (row.c || 0) + 1;
    if (row.m === undefined) row.m = 0;
    stats[k] = row;
    // 顺手清理：过老的日期不再有意义
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000);
    const cutKey = dayKey(cutoff);
    Object.keys(stats).forEach((d) => {
      if (d < cutKey) delete stats[d];
    });
    wx.setStorageSync(KEY, stats);
  } catch (e) {
    console.warn('[openStats] 记录失败：', e && e.message);
  }
}

/**
 * 累加停留时长（分钟），用于月历格子里显示「1h41m」。
 * @param {number} minutes 小数分钟，由调用方按毫秒差算好
 */
function addMinutes(minutes) {
  const m = Math.max(0, Math.floor(minutes || 0));
  if (!m) return;
  try {
    const stats = wx.getStorageSync(KEY) || {};
    const k = dayKey(new Date());
    const row = stats[k] || {};
    row.c = row.c || 0;
    row.m = (row.m || 0) + m;
    stats[k] = row;
    wx.setStorageSync(KEY, stats);
  } catch (e) {
    console.warn('[openStats] 记录时长失败：', e && e.message);
  }
}

/** 'YYYY-MM-DD'（本地时区，个人设备统计用本地日期即可） */
function dayKey(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * 时长（分钟）→ 色阶0..4。
 * 阈值按「一次认真看食谱」的几分钟量级定的：
 * 0 / ≤3 / ≤10 / ≤30 / >30 分钟，对应「没打开→扫一眼→认真看→长时间用」。
 */
function levelOfMinutes(m) {
  if (!m) return 0;
  if (m <= 3) return 1;
  if (m <= 10) return 2;
  if (m <= 30) return 3;
  return 4;
}

/** 打开次数 → 色阶（保留旧接口：万一还有别处按次数上色） */
function levelOf(count) {
  if (!count) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  return 4;
}

/**
 * 月历热力图网格（参考图那种「日历表」）。
 *
 * 布局：**列 = 星期（一..日）**，**行 = 第几个该星期几**。
 * 10 月 1 日是周四 ⇒ 第 1 行前面 3 格是空的（周一/二/三没到），
 * 这正是日历表的自然形态，也和参考图一致（当月不满的格子留空）。
 *
 * ⚠️ 渲染必须**按行读**（rows）：每行从左到右是 1,2,3,4... 这样才符合日历直觉。
 * 之前错误地按列读（weeks/col），横向就成了 5,6,7,1,2,3,4——「7 号过了是 1 号」，
 * 正是用户反馈的那个问题。
 *
 * @param {Date} [now] 用于判断「今天」和「未来日」，可注入以便测试
 * @param {number} [year]
 * @param {number} [month] 0-11
 * @returns {{rows:Array<Array<Object|null>>, weeks:Array<Array<Object>>,
 *            total:number, minutes:number, title:string, year:number, month:number}}
 *   rows  每行 7 格（不足处为 null），渲染用这个；
 *   weeks 每列 = 一个星期几的全部日期，按星期取用时用这个。
 */
function monthCalendar(now, year, month) {
  const t = now || new Date();
  const y = year === undefined ? t.getFullYear() : year;
  const m = month === undefined ? t.getMonth() : month;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const stats = readStats();

  // 直接按「行优先」填格子：日期 d 落在第 r 行（r = floor((lead + d - 1) / 7)），
  // 第 c 列（c = 星期几）。
  // ⚠️ 不能先按星期分桶再转置：那样每列内部是「该周的第几个同星期日」，
  // 转置后横向读出来是 5,6,7,1,2,3,4（用户反馈「7 号过了是 1 号」）。
  // 必须按日历的真实位置逐个日期落位，才有1..7顺读。
  //
  // 空位不用 null，而是放一个 { void:true, cls } 占位对象：
  // null 在 WXML 里取不到属性，class 就得靠 wx:if/wx:else 分支，
  // 而 wx:else 一旦被注释或空行隔断就编译失败（踩过一次）。
  // 统一成同一种对象后，WXML 只需一个元素 + {{c.cls}}，不会有分支。
  const lead = (new Date(y, m, 1).getDay() + 6) % 7; // 1 号前面空几格
  const rowCount = Math.ceil((lead + daysInMonth) / 7);
  const VOID_CELL = { void: true, d: 0, cls: 'heat__cell--void', level: -1, isToday: false, timeText: '' };
  const rows = [];
  for (let r = 0; r < rowCount; r++) rows.push([VOID_CELL, VOID_CELL, VOID_CELL, VOID_CELL, VOID_CELL, VOID_CELL, VOID_CELL]);
  let total = 0;
  let minutes = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const dow = (new Date(y, m, d).getDay() + 6) % 7; // 周一 = 0
    const isFuture =
      d > t.getDate() || y > t.getFullYear() || (y === t.getFullYear() && m > t.getMonth());
    const row = (isFuture ? null : stats[y + '-' + pad(m + 1) + '-' + pad(d)]) || {};
    const cnt = row.c || 0;
    const min = row.m || 0;
    if (!isFuture) {
      total += cnt;
      minutes += min;
    }
    const level = isFuture ? -1 : levelOfMinutes(min);
    const isToday = d === t.getDate() && y === t.getFullYear() && m === t.getMonth();
    // cls 在数据层算好：WXML 只写 class="{{c.cls}}"，不用任何 wx:if 分支
    let cls = level < 0 ? 'heat__cell--blank' : 'heat__l' + level;
    if (isToday) cls += ' heat__cell--today';
    rows[Math.floor((lead + d - 1) / 7)][dow] = {
      void: false,
      d: d,
      minutes: isFuture ? 0 : min,
      count: cnt,
      level: level,
      isToday: isToday,
      cls: cls,
      timeText: isFuture || !min ? '' : fmtMinutes(min),
    };
  }
  return {
    rows: rows,
    // 按星期分组的视图仍保留：某些用法要「每周几都在哪天」的信息
    weeks: transpose(rows),
    total: total,
    minutes: minutes,
    title: y + '年' + (m + 1) + '月',
    year: y,
    month: m,
  };
}

/** 行优先矩阵 → 列优先视图（weeks[c] = 第 c 个星期几的全部日期，跳过占位格） */
function transpose(rows) {
  const out = [[], [], [], [], [], [], []];
  rows.forEach((r) => {
    r.forEach((c, ci) => {
      if (c && !c.void) out[ci].push(c);
    });
  });
  return out;
}

/**
 * 本月热力图网格（GitHub 贡献图式：列 = 周，行 = 周一..周日）。
 * 月历形态才是 UI 用的，这个保留成「固定形状（列=周）」的视图，
 * 方便测试对照、也方便任何按周聚合的用法。
 */
function monthGrid(now) {
  const cal = monthCalendar(now);
  const t = now || new Date();
  const first = new Date(cal.year, cal.month, 1);
  const lead = (first.getDay() + 6) % 7; // 1 号前面留几个空格
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push({ d: 0, level: -1 });
  for (let d = 1; d <= new Date(cal.year, cal.month + 1, 0).getDate(); d++) {
    const isFuture =
      d > t.getDate() || cal.year > t.getFullYear() || (cal.year === t.getFullYear() && cal.month > t.getMonth());
    cells.push({ d: d, level: isFuture ? -1 : levelOf(countOf(cal.year, cal.month, d)) });
  }
  while (cells.length % 7 !== 0) cells.push({ d: 0, level: -1 });
  const out = [];
  for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
  return { weeks: out, total: cal.total };
}

/** 某天的打开次数（读 storage，内部用） */
function countOf(y, m, d) {
  const row = readStats()[y + '-' + pad(m + 1) + '-' + pad(d)] || {};
  return row.c || 0;
}

/** 分钟 → 「1h41m」/「29m」（参考图的显示格式） */
function fmtMinutes(min) {
  const m = Math.max(0, Math.floor(min || 0));
  if (!m) return '';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return rest + 'm';
  if (!rest) return h + 'h';
  return h + 'h' + rest + 'm';
}

/** 月份平移：idx 为偏移量（-1 上个月，+1 下个月） */
function shiftMonth(year, month, delta) {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function readStats() {
  try {
    return wx.getStorageSync(KEY) || {};
  } catch (e) {
    return {};
  }
}

module.exports = {
  record: record,
  addMinutes: addMinutes,
  monthCalendar: monthCalendar,
  monthGrid: monthGrid,
  levelOf: levelOf,
  levelOfMinutes: levelOfMinutes,
  fmtMinutes: fmtMinutes,
  shiftMonth: shiftMonth,
  dayKey: dayKey,
  KEY: KEY,
  KEEP_DAYS: KEEP_DAYS,
};
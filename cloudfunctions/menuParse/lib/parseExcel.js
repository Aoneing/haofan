'use strict';

/**
 * 好饭 · 周食谱解析器（纯函数，零第三方依赖）
 *
 * 输入：二维数组 AOA（Array of Arrays），每格为 string | number | null
 * 输出：{ ok, period, days, warnings, stats }
 *
 * 针对的表格形态（见 docs/解析规则.md）：
 *  - 矩阵式：列 = 星期（周日打头），行 = 餐次（早占两行：主食 + 饮品）
 *  - A1 形如 "9/20-9/26" 的文本日期区间，无年份
 *  - 菜名与配方混写在同一格，分隔符不统一（：/ ；/ 换行 / 无）
 *  - "/" 表示二选一；备料备注行按天分布；"食材准备/备餐" 为整周备注
 *
 * 告警码：W001 表头缺失 | W002 年份推断 | W003 星期不一致 | W004 合并填充
 *         W005 餐次为空 | W006 切分可疑 | W007 二选一 | W008 周期重叠(调用方处理)
 *         W009 菜名重复 | W010 行标签无法归类
 */

const WEEKDAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const WEEKDAY_ALIASES = {
  周日: 0, 周天: 0, 星期日: 0, 星期天: 0,
  周一: 1, 星期一: 1,
  周二: 2, 星期二: 2,
  周三: 3, 星期三: 3,
  周四: 4, 星期四: 4,
  周五: 5, 星期五: 5,
  周六: 6, 星期六: 6,
};

const MEAL_DEFS = [
  { key: 'breakfast', label: '早餐', test: (t) => /^早/.test(t) },
  { key: 'lunch', label: '午餐', test: (t) => /^(中餐|午餐|中|午)/.test(t) },
  { key: 'snack', label: '加餐', test: (t) => /^(加餐|点心|小食|下午茶)/.test(t) },
  { key: 'dinner', label: '晚餐', test: (t) => /^(晚餐|晚)/.test(t) },
];

const PREP_TEST = (t) => /(食材处理|解冻|备料|浸泡|泡发|腌制)/.test(t);

const GLOBAL_TESTS = [
  { label: '食材准备', test: (t) => /(食材准备|采购清单|要买的)/.test(t) },
  { label: '备餐', test: (t) => /^备餐/.test(t) },
];

// "9/20-9/26" / "9.20-9.26" / "9月20日-9月26日" / "9/20 至 9/26"
const RANGE_RE = /(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})\s*日?\s*(?:[-~～—–]|至|到)\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/;

function warn(code, level, message, detail) {
  return detail === undefined ? { code, level, message } : { code, level, message, detail };
}

function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function cellText(v) {
  if (isBlank(v)) return '';
  return String(v).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatISO(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/**
 * 自扫非空单元格求真实边界。
 * 真实表格的表维度（如 200 行 × 26 列）不可信，必须只认有内容的部分。
 */
function scanBounds(aoa) {
  let maxRow = -1;
  let maxCol = -1;
  for (let r = 0; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      if (!isBlank(row[c])) {
        if (r > maxRow) maxRow = r;
        if (c > maxCol) maxCol = c;
      }
    }
  }
  return maxRow < 0 ? null : { maxRow, maxCol };
}

/** 找表头行：含 >=5 个「周X」单元格的行，返回该行与日期列映射 */
function findHeaderRow(aoa, bounds) {
  for (let r = 0; r <= bounds.maxRow; r++) {
    const row = aoa[r] || [];
    const dayCols = [];
    for (let c = 0; c <= bounds.maxCol; c++) {
      const t = cellText(row[c]).trim();
      if (t && WEEKDAY_ALIASES[t] !== undefined) {
        dayCols.push({ col: c, text: t, weekday: WEEKDAY_ALIASES[t] });
      }
    }
    if (dayCols.length >= 5) {
      dayCols.sort((a, b) => a.col - b.col);
      return { row: r, dayCols };
    }
  }
  return null;
}

/** 在表头行 / 桩列中找 "9/20-9/26" 形式的周区间 */
function parseRangeText(aoa, header, bounds) {
  const { row, dayCols } = header;
  const firstDayCol = dayCols[0].col;
  const tryCell = (r, c) => {
    const t = cellText(aoa[r] && aoa[r][c]).trim();
    if (!t) return null;
    const m = RANGE_RE.exec(t);
    return m ? { text: t, m } : null;
  };
  for (let c = 0; c < firstDayCol; c++) {
    const hit = tryCell(row, c);
    if (hit) return hit;
  }
  for (let c = 0; c <= bounds.maxCol; c++) {
    const hit = tryCell(row, c);
    if (hit) return hit;
  }
  for (let r = 0; r <= bounds.maxRow; r++) {
    const hit = tryCell(r, 0);
    if (hit) return hit;
  }
  return null;
}

/**
 * 年份推断：表格没写年份，用「起始日的星期 == 表头首列星期」校验。
 * 候选顺序：当前年 → 下一年 → 上一年。7 天跨度必须成立。
 * 若 opts.year 显式指定（校对页用户切换年份），则直接采用、不再推断。
 */
function buildPeriod(m, opts, firstWeekday, warnings) {
  const sm = +m[1];
  const sd = +m[2];
  const em = +m[3];
  const ed = +m[4];
  const nowYear = opts.now ? new Date(opts.now).getFullYear() : new Date().getFullYear();
  const crossYear = em < sm || (em === sm && ed < sd);
  const buildEnd = (y) => new Date(y + (crossYear ? 1 : 0), em - 1, ed);

  if (typeof opts.year === 'number' && opts.year > 1990 && opts.year < 3000) {
    const start = new Date(opts.year, sm - 1, sd);
    return { start, end: buildEnd(opts.year), yearAssumed: false, verified: false };
  }

  const candidates = [nowYear, nowYear + 1, nowYear - 1];
  for (let i = 0; i < candidates.length; i++) {
    const y = candidates[i];
    const start = new Date(y, sm - 1, sd);
    const end = new Date(start.getFullYear() + (crossYear ? 1 : 0), em - 1, ed);
    const spanOk = Math.round((end - start) / 86400000) === 6;
    if (spanOk && start.getDay() === firstWeekday) {
      if (y !== nowYear) {
        warnings.push(warn('W002', 'info', `年份按「${y} 年」推断（与表头星期吻合）`));
      }
      return { start, end, yearAssumed: false, verified: true };
    }
  }
  warnings.push(
    warn('W002', 'warn', '表格未标注年份，已按当前年份推断，请在校对页确认')
  );
  const start = new Date(nowYear, sm - 1, sd);
  const end = new Date(start.getTime() + 6 * 86400000);
  return { start, end, yearAssumed: true, verified: false };
}

/**
 * 把合并单元格的值填充到整个合并范围（只填空格，不覆盖已有值）。
 * merges: [{ s: {r,c}, e: {r,c} }]，来自 SheetJS 的 ws['!merges']
 */
function applyMerges(aoa, merges) {
  let filled = 0;
  let ranges = 0;
  (merges || []).forEach((mg) => {
    if (!mg || !mg.s || !mg.e) return;
    const r1 = Math.min(mg.s.r, mg.e.r);
    const r2 = Math.max(mg.s.r, mg.e.r);
    const c1 = Math.min(mg.s.c, mg.e.c);
    const c2 = Math.max(mg.s.c, mg.e.c);
    if (r1 === r2 && c1 === c2) return;
    const v = aoa[r1] ? aoa[r1][c1] : null;
    if (isBlank(v)) return;
    ranges += 1;
    for (let r = r1; r <= r2; r++) {
      if (!aoa[r]) aoa[r] = [];
      for (let c = c1; c <= c2; c++) {
        if (r === r1 && c === c1) continue;
        if (isBlank(aoa[r][c])) {
          aoa[r][c] = v;
          filled += 1;
        }
      }
    }
  });
  return { ranges, filled };
}

/** 菜名归一化：去空白、序号、尾部标点、括号备注、加号，用于配图映射的主键 */
function normalizeDishKey(name) {
  return String(name || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/^\d+\s*[.、,，)）]/, '')
    .replace(/[，、;；。,.：:]+$/, '')
    .replace(/[（(][^）)]*[)）]/g, '')
    .replace(/[＋+]/g, '')
    .trim();
}

/** 备料步骤拆分：按换行拆行，去掉行首序号（1. / 2，/ 3） */
function splitSteps(text) {
  const lines = String(text).split(/\n+/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s*[.、,，)）]\s*(.*)$/.exec(line);
    const step = m ? m[2].trim() : line;
    if (step) out.push(step);
  }
  return out;
}

/**
 * 菜名 + 配方切分。
 * 分隔符优先级：全角冒号 > 半角冒号 > 全角分号 > 半角分号 > 换行，取最先出现者。
 * 无分隔符则整格即菜名。"/" 拆成二选一 options。
 */
function splitDish(text) {
  const t = cellText(text).trim();
  if (!t) return { displayTitle: '', options: [], recipe: null, dishKeys: [], needsReview: false };

  let cut = -1;
  for (let i = 0; i < SPLITTERS.length; i++) {
    const idx = t.indexOf(SPLITTERS[i]);
    if (idx >= 0 && (cut < 0 || idx < cut)) cut = idx;
  }

  let namePart = cut >= 0 ? t.slice(0, cut) : t;
  const recipe = cut >= 0 ? t.slice(cut + 1).trim() : null;
  namePart = namePart
    .replace(/^\s*\d+\s*[.、,，)）]\s*/, '')
    .replace(/[，、;；。,.]+$/, '')
    .trim();

  if (!namePart) {
    // 分隔符出现在开头等极端情况：整格当作菜名并标记待校对
    return {
      displayTitle: t.slice(0, 40),
      options: [],
      recipe: null,
      dishKeys: [normalizeDishKey(t)].filter(Boolean),
      needsReview: true,
    };
  }

  const options = namePart.split('/').map((s) => s.trim()).filter(Boolean);
  const multi = options.length > 1;
  const displayTitle = multi ? options.join(' 或 ') : options[0] || namePart;
  const keys = (multi ? options : [displayTitle]).map(normalizeDishKey).filter(Boolean);
  const needsReview = displayTitle.length > 20 || options.some((o) => o.length > 16);

  return {
    displayTitle,
    options: multi ? options : [],
    recipe: recipe || null,
    dishKeys: keys,
    needsReview,
  };
}

const SPLITTERS = ['：', ':', '；', ';', '\n'];

/** 行标签归类：全局备注 > 备料 > 餐次 > 未识别 */
function classifyRow(labelRaw) {
  const label = String(labelRaw || '').trim();
  if (!label) return { type: 'empty' };
  for (let i = 0; i < GLOBAL_TESTS.length; i++) {
    if (GLOBAL_TESTS[i].test(label)) {
      return { type: 'global', label: GLOBAL_TESTS[i].label, labelRaw: label };
    }
  }
  if (PREP_TEST(label)) {
    let timing = 'unknown';
    if (/[(（]早[)）]/.test(label)) timing = 'morning';
    else if (/[(（]晚[)）]/.test(label)) timing = 'evening';
    return { type: 'prep', labelRaw: label, timing };
  }
  for (let i = 0; i < MEAL_DEFS.length; i++) {
    if (MEAL_DEFS[i].test(label)) {
      return { type: 'meal', meal: MEAL_DEFS[i].key, mealLabel: MEAL_DEFS[i].label };
    }
  }
  return { type: 'unknown', labelRaw: label };
}

/**
 * 主入口：解析 AOA，产出结构化食谱。
 * @param {Array<Array>} aoa
 * @param {{ now?: number }} [opts]
 */
function parseAOA(aoa, opts) {
  opts = opts || {};
  const warnings = [];
  const bounds = scanBounds(aoa);

  if (!bounds) {
    return {
      ok: false,
      code: 'EMPTY',
      message: '表格内容为空',
      period: null,
      days: [],
      warnings: [warn('W001', 'error', '表格内容为空，请检查文件')],
      stats: {},
    };
  }

  const header = findHeaderRow(aoa, bounds);
  if (!header) {
    return {
      ok: false,
      code: 'NO_HEADER',
      message: '未找到表头行（需要一行含 5 个以上「周X」单元格）',
      period: null,
      days: [],
      warnings: [
        warn('W001', 'error', '未找到表头行：需要一行里至少 5 个「周日/周一/…」单元格'),
      ],
      stats: {},
    };
  }

  const rangeHit = parseRangeText(aoa, header, bounds);
  if (!rangeHit) {
    return {
      ok: false,
      code: 'NO_RANGE',
      message: '未找到日期区间（形如 9/20-9/26）',
      period: null,
      days: [],
      warnings: [warn('W001', 'error', '未找到日期区间文本（形如 9/20-9/26）')],
      stats: {},
    };
  }

  const firstWeekday = header.dayCols[0].weekday;
  const periodInfo = buildPeriod(rangeHit.m, opts, firstWeekday, warnings);
  const { start, end } = periodInfo;

  const period = {
    startDate: formatISO(start),
    endDate: formatISO(end),
    startWeekday: start.getDay(),
    startWeekdayText: WEEKDAY_TEXT[start.getDay()],
    rawRangeText: rangeHit.text.trim(),
    yearAssumed: periodInfo.yearAssumed,
  };

  // 生成 7 天骨架，并把日期列映射上去
  const days = [];
  const dayColCount = header.dayCols.length;
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    days.push({
      date: formatISO(d),
      weekday: d.getDay(),
      weekdayText: WEEKDAY_TEXT[d.getDay()],
      dayIndex: i,
      meals: [],
      prepNotes: [],
      globalPrep: {},
    });
  }
  if (dayColCount !== 7) {
    warnings.push(
      warn('W003', 'warn', `表头日期列数为 ${dayColCount}（期望 7），多出或缺失的列已忽略`)
    );
  }
  for (let i = 0; i < Math.min(dayColCount, 7); i++) {
    if (header.dayCols[i].weekday !== days[i].weekday) {
      warnings.push(
        warn(
          'W003',
          'warn',
          `第 ${i + 1} 列表头为「${header.dayCols[i].text}」，与日期 ${days[i].date}（${days[i].weekdayText}）推算不符`
        )
      );
    }
  }

  // 逐行处理。lastLabel 用于 A 列前向填充：合并元数据缺失时（如纯 AOA 直测），
  // 「早」合并到下一行导致的空标签行也能继承上一行的餐次。
  const firstDayCol = header.dayCols[0].col;
  const optionCells = [];
  const reviewCells = [];
  const missingCells = [];
  let lastLabel = '';

  for (let r = header.row + 1; r <= bounds.maxRow; r++) {
    const row = aoa[r] || [];

    // 桩列：从日期列往左找最近的非空单元格
    let labelRaw = '';
    for (let c = firstDayCol - 1; c >= 0; c--) {
      const t = cellText(row[c]).trim();
      if (t) {
        labelRaw = t;
        break;
      }
    }

    const hasData = header.dayCols.some((dc) => !isBlank(row[dc.col]));
    if (!labelRaw) {
      if (!hasData) {
        lastLabel = ''; // 整行空 = 分隔带，重置前向填充
        continue;
      }
      if (lastLabel) {
        labelRaw = lastLabel; // 前向填充：合并延续行
      } else {
        warnings.push(warn('W010', 'warn', `第 ${r + 1} 行有内容但左侧无标签，已跳过`));
        continue;
      }
    }

    const cls = classifyRow(labelRaw);
    lastLabel = labelRaw;

    if (cls.type === 'meal') {
      header.dayCols.forEach((dc, i) => {
        if (i >= 7) return;
        const raw = cellText(row[dc.col]).trim();
        const bucket = days[i];
        const slot = bucket.meals.filter((x) => x.meal === cls.meal).length + 1;
        if (!raw) {
          bucket.meals.push({
            meal: cls.meal,
            mealText: cls.mealLabel,
            slot,
            displayTitle: '',
            options: [],
            recipe: null,
            rawText: '',
            dishKeys: [],
            needsReview: false,
            missing: true,
          });
          missingCells.push(`${days[i].date} ${cls.mealLabel}`);
          return;
        }
        const s = splitDish(raw);
        if (s.options.length > 1) optionCells.push(`${days[i].date} ${cls.mealLabel}`);
        if (s.needsReview) reviewCells.push(`${days[i].date} ${cls.mealLabel}「${s.displayTitle}」`);
        bucket.meals.push({
          meal: cls.meal,
          mealText: cls.mealLabel,
          slot,
          displayTitle: s.displayTitle,
          options: s.options,
          recipe: s.recipe,
          rawText: raw,
          dishKeys: s.dishKeys,
          needsReview: s.needsReview,
          missing: false,
        });
      });
      continue;
    }

    if (cls.type === 'prep' || cls.type === 'unknown') {
      let any = false;
      header.dayCols.forEach((dc, i) => {
        if (i >= 7) return;
        const text = cellText(row[dc.col]).trim();
        if (!text) return;
        any = true;
        days[i].prepNotes.push({
          label: cls.labelRaw,
          timing: cls.timing || 'unknown',
          steps: splitSteps(text),
          rawText: text,
        });
      });
      if (cls.type === 'unknown') {
        warnings.push(
          warn('W010', 'warn', `第 ${r + 1} 行标签「${cls.labelRaw}」无法归类，已按备料备注保留`)
        );
      }
      if (!any) {
        // 整行备注为空（如周末无备料说明），属正常缺失，不告警
      }
      continue;
    }

    if (cls.type === 'global') {
      let val = '';
      for (let j = 0; j < header.dayCols.length; j++) {
        const t = cellText(row[header.dayCols[j].col]).trim();
        if (t) {
          val = t;
          break;
        }
      }
      if (val) {
        days.forEach((d) => {
          d.globalPrep[cls.label] = val;
        });
      }
    }
  }

  if (optionCells.length) {
    warnings.push(
      warn('W007', 'info', `${optionCells.length} 处「/」已按二选一处理（如 ${optionCells[0]}）`)
    );
  }
  if (reviewCells.length) {
    warnings.push(
      warn('W006', 'warn', `${reviewCells.length} 处菜名疑似未正确切分，请在校对页确认`, reviewCells.slice(0, 10))
    );
  }
  if (missingCells.length) {
    warnings.push(
      warn('W005', 'warn', `${missingCells.length} 处餐次为空：${missingCells.slice(0, 6).join('、')}${missingCells.length > 6 ? ' 等' : ''}`)
    );
  }

  // 同周重复菜名（提示可批量套用配图）
  const titleCount = {};
  days.forEach((d) => {
    d.meals.forEach((m) => {
      if (m.missing || !m.displayTitle) return;
      const k = normalizeDishKey(m.displayTitle);
      titleCount[k] = (titleCount[k] || 0) + 1;
    });
  });
  const dupTitles = Object.keys(titleCount).filter((k) => titleCount[k] > 1);
  if (dupTitles.length) {
    warnings.push(
      warn('W009', 'info', `本周有 ${dupTitles.length} 个菜名重复出现（如 ${dupTitles.slice(0, 3).join('、')}），可复用同一张配图`)
    );
  }

  const mealCellCount = days.reduce((n, d) => n + d.meals.filter((m) => !m.missing).length, 0);
  const prepCount = days.reduce((n, d) => n + d.prepNotes.length, 0);
  const globalPrepRows = Object.keys(days[0].globalPrep).length;

  return {
    ok: true,
    period,
    days,
    warnings,
    stats: {
      bounds: { maxRow: bounds.maxRow + 1, maxCol: bounds.maxCol + 1 },
      headerRow: header.row + 1,
      mealCells: mealCellCount,
      prepNotes: prepCount,
      globalPrepRows,
    },
  };
}

module.exports = {
  WEEKDAY_TEXT,
  WEEKDAY_ALIASES,
  MEAL_DEFS,
  parseAOA,
  applyMerges,
  scanBounds,
  findHeaderRow,
  splitDish,
  splitSteps,
  normalizeDishKey,
  warn,
};

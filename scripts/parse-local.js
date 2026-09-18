'use strict';

/**
 * 本地解析脚本：不开小程序、不部署云函数，直接对真实 Excel 出结构化 JSON。
 *
 * 用法：
 *   1. 在项目根目录安装一次依赖：npm install xlsx
 *      （或复用云函数目录里已安装的：cd cloudfunctions/menuParse && npm install）
 *   2. node scripts/parse-local.js "C:\path\to\food(1).xlsx"
 *      可选 --out result.json 把完整 JSON 写入文件
 *
 * M1 里程碑的验收方式：跑这个脚本，把 35 个菜品单元逐格与 Excel 核对。
 */

const fs = require('fs');
const path = require('path');

function loadXlsx() {
  const candidates = [
    'xlsx',
    path.join(__dirname, '..', 'node_modules', 'xlsx'),
    path.join(__dirname, '..', 'cloudfunctions', 'menuParse', 'node_modules', 'xlsx'),
  ];
  for (let i = 0; i < candidates.length; i++) {
    try {
      return require(candidates[i]);
    } catch (e) {
      /* try next */
    }
  }
  throw new Error(
    '未找到 xlsx 依赖。请先在项目根目录执行 npm install xlsx，或到 cloudfunctions/menuParse 下执行 npm install'
  );
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  let outFile = null;
  if (outIdx >= 0) {
    outFile = args[outIdx + 1];
    args.splice(outIdx, 2);
  }
  const file = args[0];
  if (!file) {
    process.stdout.write('用法：node scripts/parse-local.js <xlsx路径> [--out result.json]\n');
    process.exit(1);
  }

  const XLSX = loadXlsx();
  const buf = fs.readFileSync(path.resolve(file));
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error('工作簿中没有工作表');

  const aoa = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: null,
    blankrows: true,
    raw: false,
  });
  const mergeInfo = require('../cloudfunctions/menuParse/lib/parseExcel').applyMerges(
    aoa,
    ws['!merges'] || []
  );

  const result = parse(aoa);
  if (mergeInfo.ranges > 0) {
    result.warnings.unshift({
      code: 'W004',
      level: 'info',
      message: `检测到 ${mergeInfo.ranges} 处合并单元格，已按合并范围填充（共 ${mergeInfo.filled} 格）`,
    });
  }

  // 人类可读的摘要
  const p = result.period;
  process.stdout.write('\n===== 好饭 · 解析结果 =====\n');
  if (!result.ok) {
    process.stdout.write('解析失败 [' + result.code + '] ' + result.message + '\n');
    result.warnings.forEach((w) => process.stdout.write('  [' + w.code + '] ' + w.message + '\n'));
    process.exit(2);
  }
  process.stdout.write(
    '周期：' + p.startDate + '（' + p.startWeekdayText + '） ~ ' + p.endDate +
      '  原文「' + p.rawRangeText + '」' + (p.yearAssumed ? '（年份为推断）' : '') + '\n'
  );
  process.stdout.write(
    '统计：菜品单元 ' + result.stats.mealCells + ' 个，备料备注 ' + result.stats.prepNotes +
      ' 条，整周备注 ' + result.stats.globalPrepRows + ' 条，真实边界 ' +
      result.stats.bounds.maxRow + ' 行 × ' + result.stats.bounds.maxCol + ' 列\n'
  );
  process.stdout.write('\n告警 ' + result.warnings.length + ' 条：\n');
  result.warnings.forEach((w) => process.stdout.write('  [' + w.code + '/' + w.level + '] ' + w.message + '\n'));

  process.stdout.write('\n逐日预览：\n');
  result.days.forEach((d) => {
    process.stdout.write('\n  ' + d.date + ' ' + d.weekdayText + '\n');
    d.meals.forEach((m) => {
      const title = m.missing ? '（空）' : m.displayTitle;
      process.stdout.write('    [' + m.mealText + '#' + m.slot + '] ' + title + (m.needsReview ? '  ← 待校对' : '') + '\n');
      if (m.recipe) process.stdout.write('        配方：' + m.recipe.replace(/\n/g, ' / ') + '\n');
    });
    d.prepNotes.forEach((n) => {
      process.stdout.write('    [备注] ' + n.label + '（' + n.timing + '）' + n.steps.join('；') + '\n');
    });
    const g = Object.keys(d.globalPrep);
    if (g.length) process.stdout.write('    [整周] ' + g.map((k) => k + '：' + d.globalPrep[k]).join('  ') + '\n');
  });

  if (outFile) {
    fs.writeFileSync(path.resolve(outFile), JSON.stringify(result, null, 2), 'utf8');
    process.stdout.write('\n完整 JSON 已写入：' + path.resolve(outFile) + '\n');
  }
  process.stdout.write('\n');
}

function parse(aoa) {
  return require('../cloudfunctions/menuParse/lib/parseExcel').parseAOA(aoa, { now: Date.now() });
}

main();

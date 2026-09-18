'use strict';

const cloud = require('wx-server-sdk');
const XLSX = require('xlsx');
const { parseAOA, applyMerges } = require('./lib/parseExcel');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 解析云存储中的周食谱 Excel，返回结构化 JSON + 告警列表。
 * 只解析、不写库；落库由 menuSave 在人工校对之后完成。
 *
 * 入参：{ fileID, yearOverride? }
 *  - yearOverride：校对页用户显式切换年份后重传，直接采用、跳过年份推断
 */
exports.main = async (event) => {
  try {
    const fileID = event && event.fileID;
    if (!fileID) {
      return { ok: false, message: '缺少 fileID 参数' };
    }

    const res = await cloud.downloadFile({ fileID });
    if (!res || !res.fileContent) {
      return { ok: false, message: '文件下载失败：' + (res && res.errMsg ? res.errMsg : '未知原因') };
    }

    let wb;
    try {
      wb = XLSX.read(res.fileContent, { type: 'buffer' });
    } catch (e) {
      return { ok: false, message: '文件不是有效的 Excel（.xlsx/.xls）：' + e.message };
    }

    const sheetName = wb.SheetNames[0];
    const ws = sheetName ? wb.Sheets[sheetName] : null;
    if (!ws) {
      return { ok: false, message: '工作簿中没有工作表' };
    }

    const aoa = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      defval: null,
      blankrows: true,
      raw: false,
    });

    // 先按合并单元格填充（A2:A3、B10:H10 这类），再进入纯解析
    const mergeInfo = applyMerges(aoa, ws['!merges'] || []);
    const yearOverride = event.yearOverride;
    const result = parseAOA(aoa, {
      now: Date.now(),
      year: typeof yearOverride === 'number' ? yearOverride : undefined,
    });

    if (mergeInfo.ranges > 0) {
      result.warnings.unshift({
        code: 'W004',
        level: 'info',
        message: `检测到 ${mergeInfo.ranges} 处合并单元格，已按合并范围填充（共 ${mergeInfo.filled} 格）`,
      });
    }
    result.sheetName = sheetName;
    result.fileID = fileID;
    return result;
  } catch (e) {
    console.error('[menuParse] failed', e);
    return { ok: false, message: '解析失败：' + (e && e.message ? e.message : '未知错误') };
  }
};

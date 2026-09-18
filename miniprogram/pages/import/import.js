// pages/import/import.js — 三步导入向导：选文件 → 校对 → 保存
const api = require('../../utils/api');
const imageStore = require('../../utils/imageStore');
const dateUtil = require('../../utils/date');

Page({
  data: {
    step: 1,

    // 第 1 步
    fileName: '',
    fileSizeText: '',
    filePath: '',
    busy: false,
    parseError: '',

    // 第 2 步
    fileID: '',
    period: null,
    periodRangeText: '',
    stats: null,
    reviewCount: 0,
    missingCount: 0,
    warnings: [],
    days: [], // [{ day, images }]
    years: [],
    yearIndex: 0,
    parsing: false,
    saving: false,
    saveError: '',

    // 第 3 步
    savedPeriodId: '',
  },

  /* ---------- 第 1 步：选文件 & 解析 ---------- */

  chooseFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['xlsx', 'xls'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        this.setData({
          fileName: f.name,
          filePath: f.path,
          fileSizeText: Math.max(1, Math.round((f.size || 0) / 1024)) + ' KB',
          parseError: '',
        });
      },
    });
  },

  async startParse() {
    if (this.data.busy) return;
    this.setData({ busy: true, parseError: '' });
    try {
      const fileID = await api.uploadExcel(this.data.filePath, this.data.fileName);
      this.setData({ fileID });
      const ok = await this.parseAndPrepare(fileID, undefined);
      if (ok) {
        // 首解析：候选年份以解析结果为中心，选中中间项（即本次推断出的年份）
        const startYear = Number(this.data.period.startDate.slice(0, 4));
        this.setData({
          years: [startYear - 1, startYear, startYear + 1],
          yearIndex: 1,
          step: 2,
        });
      }
    } catch (e) {
      this.setData({ parseError: e.message || '解析失败' });
    } finally {
      this.setData({ busy: false });
    }
  },

  /** 解析 + 预处理视图数据；year 传入时为校对页年份切换后的重解析 */
  async parseAndPrepare(fileID, year) {
    this.setData({ parsing: true });
    try {
      const res = await api.parse(fileID, year);
      if (!res.ok) {
        // 解析器阻断性失败（EMPTY/NO_HEADER/NO_RANGE）或其它错误
        throw new Error(res.message || (res.warnings && res.warnings[0] && res.warnings[0].message) || '解析失败');
      }

      const keys = [];
      res.days.forEach((d) =>
        (d.meals || []).forEach((m) => (m.dishKeys || []).forEach((k) => k && keys.push(k)))
      );
      await imageStore.hydrate(keys);

      let reviewCount = 0;
      let missingCount = 0;
      res.days.forEach((d) =>
        (d.meals || []).forEach((m) => {
          if (m.missing) missingCount += 1;
          else if (m.needsReview) reviewCount += 1;
        })
      );

      const startYear = Number(res.period.startDate.slice(0, 4));
      // years 的候选窗口以「用户当前选中的年份」为中心更稳：切到 2025 后不该又跳回 2026。
      // 首次解析（未指定 year）时以解析出的年份为中心。
      const centerYear = typeof year === 'number' ? year : startYear;
      const nextYears = [centerYear - 1, centerYear, centerYear + 1];
      const curYears = this.data.years || [];
      // 仅在年份候选窗口真的变了的时候才重建，避免 picker 选中项反复跳动
      const yearsChanged =
        curYears.length !== 3 ||
        curYears[0] !== nextYears[0] ||
        curYears[1] !== nextYears[1] ||
        curYears[2] !== nextYears[2];

      const patch = {
        period: res.period,
        periodRangeText:
          dateUtil.fmtRange(res.period.startDate, res.period.endDate) +
          '（' +
          res.period.startWeekdayText +
          '打头）',
        stats: res.stats || null,
        reviewCount,
        missingCount,
        warnings: res.warnings || [],
        days: res.days.map((d) => ({ day: d, images: pickImages(d) })),
      };
      if (yearsChanged) {
        patch.years = nextYears;
        // yearIndex 由调用方（onYearChange / 首解析）决定，这里不设置，
        // 否则会在「切换到 +1 年」时被重置回中间项，选中项与实际年份不一致。
      }
      this.setData(patch);
      return true;
    } finally {
      this.setData({ parsing: false });
    }
  },

  /* ---------- 第 2 步：校对 ---------- */

  async onYearChange(e) {
    const idx = Number(e.detail.value);
    const y = this.data.years[idx];
    if (!y || idx === this.data.yearIndex) return;
    try {
      await this.parseAndPrepare(this.data.fileID, y);
      this.setData({ yearIndex: idx });
    } catch (err) {
      wx.showToast({ title: err.message || '重解析失败', icon: 'none' });
    }
  },

  async confirmSave() {
    if (this.data.saving) return;
    const { period, days, stats } = this.data;
    this.setData({ saving: true, saveError: '' });
    try {
      const res = await api.save({ period, days: days.map((x) => x.day), stats, mode: 'ask' });
      if (res.ok) {
        this.enterDone(res);
        return;
      }
      if (res.code === 'PERIOD_OVERLAP') {
        const names = (res.overlapping || [])
          .slice(0, 3)
          .map((p) => p.startDate + '~' + p.endDate)
          .join('、');
        wx.showModal({
          title: '与已有食谱重叠',
          content: '检测到周期 ' + names + ' 与本次导入重叠。覆盖后旧数据将被替换，确定吗？',
          confirmText: '覆盖',
          cancelText: '取消',
          success: (r) => {
            if (r.confirm) this.saveOverwrite();
            else this.setData({ saving: false });
          },
        });
        return;
      }
      throw new Error(res.message || '保存失败');
    } catch (e) {
      this.setData({ saveError: e.message || '保存失败', saving: false });
    }
  },

  async saveOverwrite() {
    const { period, days, stats } = this.data;
    try {
      const res = await api.save({
        period,
        days: days.map((x) => x.day),
        stats,
        mode: 'overwrite',
      });
      if (res.ok) this.enterDone(res);
      else throw new Error(res.message || '覆盖保存失败');
    } catch (e) {
      this.setData({ saveError: e.message || '覆盖保存失败', saving: false });
    }
  },

  enterDone(res) {
    this.setData({
      saving: false,
      step: 3,
      savedPeriodId: res.periodId || this.data.period.startDate + '~' + this.data.period.endDate,
    });
  },

  /* ---------- 第 3 步：完成 ---------- */

  goToday() {
    wx.switchTab({ url: '/pages/today/today' });
  },
  goWeek() {
    getApp().globalData.pendingWeekPeriodId = this.data.savedPeriodId;
    wx.switchTab({ url: '/pages/week/week' });
  },
  restart() {
    this.setData({
      step: 1,
      fileName: '',
      filePath: '',
      fileSizeText: '',
      fileID: '',
      parseError: '',
      saveError: '',
    });
  },

  onDayTap(e) {
    wx.navigateTo({ url: '/pages/day/day?date=' + e.detail.date });
  },
});

function pickImages(day) {
  const map = {};
  (day.meals || []).forEach((m) => {
    const k = m.dishKeys && m.dishKeys[0];
    if (k) {
      const u = imageStore.get(k);
      if (u) map[k] = u;
    }
  });
  return map;
}

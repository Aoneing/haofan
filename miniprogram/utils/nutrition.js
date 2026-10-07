'use strict';

/**
 * utils/nutrition.js — 菜品的热量与烹饪时长估算
 *
 * 为什么需要它：UI 定稿里每张菜品色卡都带「热量 / 用时」两行，
 * 而食谱 Excel 里根本没有这两列（只有菜名和配方）。要么把这两行删掉，
 * 要么给出估算值 —— 这里选后者，因为「看一眼就知道今天热量大概多少、
 * 这道菜要炖多久」对家庭饮食规划是有实际价值的。
 *
 * 定位要说清楚：**这是估算，不是营养学计算**。
 * 依据是「常见配比 + 常见做法耗时」的经验值，误差个几十千卡很正常。
 * 所以 UI 上不写「精确值」的字样，也不提供编辑入口 ——
 * 一旦让人能改，它就得承担准确性的责任，而现在它承担不了。
 *
 * 纯函数、零依赖：可以在 node 里直接跑回归，也便于日后换成真正的数据源。
 */

/* ---------- 食材热量表（每 100g 千卡） ---------- */
const INGRED_KCAL = {
  // 主食
  米饭: 116, 大米: 346, 面粉: 344, 面条: 280, 馒头: 223, 面包: 280,
  粥: 46, 米糊: 60, 燕麦: 377, 玉米: 112, 红薯: 86, 土豆: 81, 山药: 57,
  南瓜: 23, 芋头: 56, 藜麦: 368,
  // 蛋白
  鸡胸肉: 133, 鸡肉: 133, 鸡蛋: 144, 蛋: 144, 虾: 48, 虾仁: 48,
  牛肉: 125, 猪肉: 143, 排骨: 278, 培根: 181, 香肠: 212,
  鳕鱼: 82, 龙利鱼: 82, 黄鱼: 86, 三文鱼: 139, 鲈鱼: 105,
  // 奶豆
  牛奶: 54, 酸奶: 72, 奶: 54, 豆浆: 31, 豆腐: 82, 芝士: 328,
  // 蔬果
  西兰花: 34, 菠菜: 24, 生菜: 15, 青菜: 15, 黄瓜: 16, 番茄: 18, 西红柿: 18,
  萝卜: 21, 胡萝卜: 41, 莲藕: 73, 香菇: 26, 木耳: 27,
  苹果: 53, 雪梨: 44, 梨: 44, 香蕉: 93, 橙: 48, 蓝莓: 57, 草莓: 32,
  葡萄: 45, 芒果: 60, 火龙果: 55, 猕猴桃: 61,
};

/* ---------- 做法 → 烹饪时长（分钟） ---------- */
const COOK_MINUTES = [
  { kw: ['炖', '煲'], min: 90 },// 汤/粥慢炖
  { kw: ['焖', '卤'], min: 60 },
  { kw: ['蒸'], min: 25 },
  { kw: ['烤', '烘'], min: 35 },
  { kw: ['煮', '汤', '羹'], min: 30 },
  { kw: ['炒'], min: 15 },
  { kw: ['煎'], min: 12 },
  { kw: ['凉拌', '沙拉', '生'], min: 8 },
  { kw: ['饮', '水', '奶', '茶', '汁'], min: 5 },
];

/** 没有任何关键词命中时的兜底：一顿家常菜的平均值 */
const DEFAULT_MINUTES = 20;

/**
 * 单份基础热量：按菜名关键词命中的食材，取该食材「一份」的量。
 * 家里给小孩做的辅食，一份大致在 80–150g 之间，取 100g 起步，
 * 再按菜名里的分量词（几个 / 一碗 / 半碗）微调。
 */
const DEFAULT_PORTION_G = 100;

/** 一顿辅食主食/正餐的热量下限：低于这个值说明估算漏了主食，用户会以为算错了 */
const MIN_MAIN_KCAL = 80;

function lookupKcalByName(title) {
  const name = String(title || '');
  let best = null;
  Object.keys(INGRED_KCAL).forEach((k) => {
    if (name.indexOf(k) < 0) return;
    // 取最长命中：「鸡蛋」比「蛋」更具体，后者只作为兜底
    if (!best || k.length > best.length) best = k;
  });
  return best;
}

/**
 * 估算一道菜的热量（千卡）与烹饪时长（分钟）。
 *
 * @param {string} title 菜名，如「土豆烤蛋奶」
 * @param {string} [recipe] 配方文本，如「18g 莲藕，18g苹果」—— 有它才能算准
 * @returns {{kcal:number, minutes:number, estimated:boolean}} estimated 恒为 true：
 *   提醒调用方这是估算值，别把它当精确营养数据用（比如别拿去做减脂计划）。
 */
function estimateDish(title, recipe) {
  const text = (String(title || '') + ' ' + String(recipe || '')).trim();
  return {
    kcal: estimateKcal(title, recipe),
    minutes: estimateMinutes(text),
    estimated: true,
  };
}

/** 热量估算：优先用配方里的克数，配方缺失时退回按菜名估一份 */
function estimateKcal(title, recipe) {
  const byRecipe = sumKcalFromRecipe(recipe);
  if (byRecipe > 0) return Math.round(byRecipe);

  const hit = lookupKcalByName(title);
  if (!hit) return MIN_MAIN_KCAL;
  return Math.round((INGRED_KCAL[hit] * DEFAULT_PORTION_G) / 100);
}

/**
 * 从配方文本里累加热量。
 * 只认「数字 + g / 克」这种明确带单位的写法（家里表格就是这么记的：
 * 「18g 莲藕，18g苹果」）；认不出的片段直接跳过，而不是猜。
 */
function sumKcalFromRecipe(recipe) {
  const src = String(recipe || '');
  if (!src) return 0;
  // 抓「18g 莲藕」「20 克苹果」这类片段：数字 + 单位 + 紧跟的食材名
  const re = /(\d+(?:\.\d+)?)\s*(?:g|G|克)\s*([^\d，,。;；、\n]{1,8})/g;
  let total = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    const grams = parseFloat(m[1]);
    if (!Number.isFinite(grams) || grams <= 0 || grams > 2000) continue;
    const hit = lookupKcalByName(m[2]);
    if (!hit) continue;
    total += (INGRED_KCAL[hit] * grams) / 100;
  }
  return total;
}

/** 烹饪时长：按菜名 + 配方里出现的做法关键词取最长的那个 */
function estimateMinutes(text) {
  const src = String(text || '');
  let best = 0;
  COOK_MINUTES.forEach((rule) => {
    rule.kw.forEach((k) => {
      if (src.indexOf(k) >= 0 && rule.min > best) best = rule.min;
    });
  });
  return best || DEFAULT_MINUTES;
}

/** 展示用文案：「320 kcal」/「12 分钟」 */
function fmtKcal(kcal) {
  return Math.max(0, Math.round(kcal || 0)) + ' kcal';
}
function fmtMinutes(min) {
  return Math.max(0, Math.round(min || 0)) + ' 分钟';
}

module.exports = {
  estimateDish,
  estimateKcal,
  estimateMinutes,
  fmtKcal,
  fmtMinutes,
  INGRED_KCAL,
  DEFAULT_MINUTES,
  MIN_MAIN_KCAL,
};
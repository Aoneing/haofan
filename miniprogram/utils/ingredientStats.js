'use strict';
/**
 * 食材分析：从一周食谱里抽取「吃了哪些食材」并分类汇总。
 *
 * 为什么是本地工具而不是云函数：
 *   - 与 openStats 同思路——统计是前端展示用，不依赖服务端算力；
 *   - 一周数据量极小（7 天 × 3 餐），手机本地算零延迟、零云调用，符合免费套餐省资源的基调。
 *
 * 数据现实（证据先行，先看了库结构再定方案）：
 *   - days[].meals[] 里只有 displayTitle（菜名）、recipe（做法自由文本）、rawText，
 *     没有任何结构化的「食材清单」字段；
 *   - 菜名通常点名主食材（如「照烧茄子鹅肝烩饭」= 茄子+鹅肝+饭），
 *     做法文本里则塞满备料词（柠檬汁/玉米淀粉/辅食油），会污染统计。
 *   → 因此**只扫 displayTitle**，用一份手维护的中文食材关键词字典做最长匹配。
 *
 * 这本质是启发式（菜名没写到的食材不会计入），但对「这周大概吃了啥、各占多少」
 * 这种家庭视角的概览足够，且零维护成本、可随字典迭代。
 */

/** 六大类。顺序即图例顺序；color 直接喂给堆叠条，确保和全局配色同源 */
const CATEGORIES = [
  { key: 'protein', label: '蛋白质', color: '#3b3aae' }, // 品牌紫
  { key: 'veg', label: '蔬菜', color: '#2f9e6b' }, // 绿
  { key: 'carb', label: '碳水', color: '#e9f94e' }, // 柠檬黄
  { key: 'drink', label: '饮品', color: '#7c8cd8' }, // 中紫
  { key: 'fruit', label: '水果', color: '#f08fb0' }, // 粉
  { key: 'other', label: '其他', color: '#b8b9c0' }, // 灰
];

/**
 * 食材关键词 → 类别。每个词只归一类（冲突时按「最贴切」归属），
 * 不重复列在多个类里，避免重复计数。
 * 命名偏好 2 字以上完整词，单字（如「米」「面」）只在没更长词可命中时才用。
 */
const DICT = {
  protein: [
    '牛肉', '猪肉', '鸡肉', '鹅肝', '猪肝', '鸡肝', '三文鱼', '鳕鱼', '龙利鱼', '黄鱼',
    '鲜虾', '虾', '鱼', '鸡蛋', '蛋黄', '蒸蛋', '鹌鹑蛋', '奶酪', '芝士',
    '豆腐', '豆浆', '黄豆', '黑豆', '红豆', '绿豆', '牛肉松', '肉松', '虾皮',
  ],
  veg: [
    '秋葵', '茄子', '洋葱', '南瓜', '莲藕', '西兰花', '菠菜', '番茄', '西红柿', '白菜',
    '青菜', '生菜', '黄瓜', '胡萝卜', '土豆', '紫薯', '红薯', '芦笋', '西葫芦', '冬瓜',
    '丝瓜', '香菇', '蘑菇', '木耳', '芹菜', '韭菜', '娃娃菜', '小白菜',
  ],
  carb: [
    '大米糕', '米糕', '米糊', '粥', '米饭', '蝴蝶面', '面条', '面', '烩饭', '炒饭',
    '馒头', '饼', '小米', '燕麦', '胚芽米', '杂粮', '米粉', '糕',
  ],
  drink: [
    '六物饮', '饮', '汤', '奶', '酸奶',
  ],
  fruit: [
    '苹果', '香蕉', '梨', '橙', '草莓', '蓝莓', '猕猴桃', '芒果', '木瓜', '火龙果',
    '牛油果', '西梅', '红枣', '枸杞',
  ],
  other: [
    '核桃', '芝麻', '山药', '莲藕',
  ],
};

// 展平成 [{kw, cat}]，按关键词长度倒序——保证「蝴蝶面」先于「面」命中
const TABLE = [];
Object.keys(DICT).forEach((cat) => {
  DICT[cat].forEach((kw) => TABLE.push({ kw, cat }));
});
TABLE.sort((a, b) => b.kw.length - a.kw.length);

/**
 * 分析一周食材。
 * @param {Array} days  menuQuery.getWeek 返回的 days（含 meals）
 * @returns {{
 *   ready: boolean,
 *   variety: number,            // 本周食材种类数（去重后的关键词数）
 *   totalHits: number,          // 所有类别命中的总次数（用于占比分母）
 *   categories: Array<{key,label,color,count,ratio,pct,items}>,
 *                 items = 本类实际命中的食材名（去重，给展开小字用）
 *   byCategory: Object,         // { catKey: [关键词...] } 给「明细」用
 *   weekRange: string,          // 「09-28 ~ 10-04」这类区间文案
 * }}
 */
function analyzeWeek(days) {
  const empty = {
    ready: false,
    variety: 0,
    totalHits: 0,
    categories: CATEGORIES.map((c) => ({ ...c, count: 0, ratio: 0, pct: '0%' })),
    byCategory: {},
    weekRange: '',
  };
  if (!Array.isArray(days) || !days.length) return empty;

  const catCount = {};
  const byCat = {};
  const weekKeys = new Set(); // 本周去重食材词（种类）

  days.forEach((day) => {
    const meals = (day && day.meals) || [];
    meals.forEach((m) => {
      if (!m || m.missing) return;
      const title = (m.displayTitle || '') + '';
      if (!title) return;
      // 一道菜里同一关键词只记一次，且**嵌套词不重复计**：
      // 例「大米糕」会同时命中 大米糕/米糕/糕，TABLE 已按词长倒序，
      // 用「已匹配区间」挡掉更短词的重叠命中，只保留最长的那一个。
      const found = new Set();
      const matchedRanges = [];
      TABLE.forEach((e) => {
        let idx = title.indexOf(e.kw);
        while (idx >= 0) {
          const end = idx + e.kw.length;
          const overlap = matchedRanges.some((r) => !(end <= r.start || idx >= r.end));
          if (!overlap) {
            matchedRanges.push({ start: idx, end });
            found.add(e.kw + '|' + e.cat);
            break; // 同一个词在这道菜里记一次即可
          }
          idx = title.indexOf(e.kw, idx + 1);
        }
      });
      found.forEach((pair) => {
        const cut = pair.lastIndexOf('|');
        const kw = pair.slice(0, cut);
        const cat = pair.slice(cut + 1);
        catCount[cat] = (catCount[cat] || 0) + 1;
        (byCat[cat] = byCat[cat] || new Set()).add(kw);
        weekKeys.add(kw);
      });
    });
  });

  const totalHits = Object.values(catCount).reduce((s, n) => s + n, 0);
  const categories = CATEGORIES.map((c) => {
    const count = catCount[c.key] || 0;
    const ratio = totalHits ? count / totalHits : 0;
    return {
      ...c,
      count,
      ratio,
      pct: Math.round(ratio * 100) + '%',
      // 本类实际命中的食材（去重），给展开的图例做小字明细
      items: Array.from(byCat[c.key] || []),
    };
  });

  // 区间文案：取最前最后一天的 date（YYYY-MM-DD）
  const sorted = days.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = (sorted[0].date || '').slice(5);
  const last = (sorted[sorted.length - 1].date || '').slice(5);

  return {
    ready: totalHits > 0,
    variety: weekKeys.size,
    totalHits,
    categories,
    byCategory: Object.keys(byCat).reduce((o, k) => {
      o[k] = Array.from(byCat[k]);
      return o;
    }, {}),
    weekRange: first && last ? first + ' ~ ' + last : '',
  };
}

module.exports = { CATEGORIES, DICT, analyzeWeek };

# 好饭 haofan

<p align="center">
  <img src="logo/final/haofan-logo-final.png" width="180" alt="好饭 logo" />
</p>

> haofan for momo 🍚

给家里的一周食谱微信小程序：把家里人发的每周食谱 Excel 一键导入，今天、明天吃什么随时打开就能看。

## 功能

- **Excel 一键导入**：从聊天记录选择 `.xlsx` → 自动解析成「周期 + 7 天 + 餐次」结构，逐格容错（合并单元格、文本日期补年份、菜名配方混写切分……）
- **三态首页**：进行中显示今天（高亮）与明天（虚线预览）；期前倒计时；期后提示导入新表
- **一周 / 单日视图**：按餐次配色（早餐米黄 / 午餐绿 / 加餐粉 / 晚餐蓝），备料备注早晚分栏
- **配图系统**：菜名归一化作为主键，全库复用同一张图；支持接入 OpenAI 兼容生图接口一键生成，未配置时文字占位
- **导入即校对**：解析结果先人工过目（告警码 + 待校对标记 + 年份切换重算星期），确认后才落库；周期重叠时弹窗确认覆盖

## 技术架构

微信小程序原生框架 + 微信云开发（无服务器 / 域名 / 备案）。

```
Excel → menuParse（解析+告警，不落库）
      → 人工校对（校对页）
      → menuSave（幂等 upsert：periods / days）
首页 ← menuQuery（服务器时间 +8h 定位今天/明天，三态）
配图 ← dishImage（resolve 批量查 / generate AI 生成 / stats）
```

数据模型（云数据库集合，需手动创建）：

| 集合 | `_id` | 说明 |
| --- | --- | --- |
| `periods` | `startDate~endDate` | 一期食谱的元信息，天然幂等 |
| `days` | `YYYY-MM-DD` | 一天一条，今天/明天 O(1) 查询 |
| `dishImages` | 归一化菜名 | 菜名 → 云存储图片 fileID |

## 目录结构

```
haofan/
├── project.config.json        # 微信开发者工具配置（miniprogramRoot + cloudfunctionRoot）
├── miniprogram/               # 小程序端（6 页 + 2 组件）
│   ├── config.js              # 部署配置（唯一可能需要手填的地方，留空即用默认环境）
│   ├── pages/                 # today / week / day / dish / import / mine
│   ├── components/            # day-card（单日卡片）、dish-thumb（配图/占位）
│   └── utils/                 # api 封装、日期工具、配图缓存、常量
├── cloudfunctions/            # 四个云函数
│   ├── menuParse/             # Excel 解析（xlsx + lib/parseExcel.js）
│   ├── menuSave/              # 校对后落库（周期重叠检测）
│   ├── menuQuery/             # getContext / getWeek / getDay / listPeriods
│   └── dishImage/             # 配图 resolve / generate / stats
├── tests/                     # 零依赖单测（node tests/run.js）
├── scripts/
│   ├── parse-local.js         # 本地解析真实 Excel 的 CLI
│   └── preflight.js           # 部署前自检（npm run preflight）
└── docs/
    ├── 部署手册.md            # 0 元部署全流程 + 排错表
    └── 解析规则.md            # 表格陷阱 → 解析对策 → 告警码
```

## 快速开始

> 完整手把手步骤见 **[docs/部署手册.md](docs/部署手册.md)**（含 0 元方案的成本依据与逐步操作）。

1. **注册小程序拿 AppID**：<https://mp.weixin.qq.com/> 注册（个人主体免费，无需 300 元认证费）
2. **导入项目**：微信开发者工具导入本仓库根目录，粘贴 AppID，后端服务选「微信云开发」
3. **开通云开发**：工具栏「云开发」→ 创建免费环境（**无需把环境 ID 填进代码**：单环境时 `miniprogram/config.js` 留空即用默认环境；多环境才需要填 `cloudEnv`）
4. **建集合**：云开发控制台建 `periods` / `days` / `dishImages` 三个集合
5. **部署云函数**：右键 `cloudfunctions` 下四个目录各「上传并部署（云端安装依赖）」
6. **导入第一份表**：小程序「导入食谱」→ 从聊天记录选 Excel → 校对 → 保存
7. **手机访问**：工具「预览」自己扫，或「上传 → 后台设为体验版」发家庭群（体验版 0 元、免审核、免备案）

## 开发

```bash
npm test                        # 解析器单元测试（零依赖，node 原生 assert）
npm run preflight               # 部署前自检：AppID / 云环境 / 页面完整 / 云函数依赖 / 语法
node scripts/parse-local.js path/to/food.xlsx   # 本地解析真实 Excel 出 JSON 摘要
npm run lint                    # ESLint
```

解析器是零依赖纯函数（`cloudfunctions/menuParse/lib/parseExcel.js`），与 SheetJS 完全解耦，可以直接在 Node 里跑测试。

## 成本

| 方案 | 费用 | 说明 |
| --- | --- | --- |
| 只用体验版（自己/家人加为体验成员） | **0 元** | 个人主体注册免费（无需 300 元微信认证，个人小程序开云开发无认证限制）+ 云开发免费体验环境 + 体验版免审核免备案 |
| 正式发布 | ≈ 239 元/年 | 云开发基础套餐 19.9 元/月（2GB 容量、20 万次调用/月） |

> ⚠️ 云开发免费体验环境：2025-02-19 起未创建过云环境的小程序账号可创建 1 个，**未发布上线期间无需续费**；小程序**正式发布上线后**将转为付费环境（下一续费周期生效）。该活动截止 2026-12-31。
> 备份策略：留好每次导入的 Excel 原文件即可全量重建。


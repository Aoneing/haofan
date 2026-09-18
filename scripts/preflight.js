#!/usr/bin/env node
'use strict';

/**
 * 部署前自检 —— 上传代码之前跑一次，把能在本地发现的问题全部揪出来。
 *
 *   node scripts/preflight.js
 *
 * 只读检查，不改任何文件。退出码：0 = 无阻断问题，1 = 有必须处理的问题。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');
const CF = path.join(ROOT, 'cloudfunctions');

const checks = [];
function ok(name, detail) {
  checks.push({ level: 'ok', name, detail: detail || '' });
}
function warn(name, detail) {
  checks.push({ level: 'warn', name, detail: detail || '' });
}
function fail(name, detail) {
  checks.push({ level: 'fail', name, detail: detail || '' });
}

function exists(p) {
  return fs.existsSync(p);
}
function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/* ---------- 1. AppID ---------- */
(function checkAppId() {
  const p = path.join(ROOT, 'project.config.json');
  if (!exists(p)) return fail('project.config.json', '文件缺失');
  let cfg;
  try {
    cfg = readJSON(p);
  } catch (e) {
    return fail('project.config.json', 'JSON 解析失败：' + e.message);
  }
  const appid = cfg.appid || '';
  if (!appid || appid === 'touristappid') {
    fail(
      '小程序 AppID',
      '仍是占位值 touristappid —— 必须替换为你的真实 AppID（小程序后台 → 开发 → 开发设置 → AppID）'
    );
  } else if (appid === 'wx' || appid.length < 10) {
    warn('小程序 AppID', '看起来不像合法 AppID：' + appid);
  } else {
    ok('小程序 AppID', appid);
  }
  if (cfg.cloudfunctionRoot !== 'cloudfunctions/') {
    fail('cloudfunctionRoot', '应为 cloudfunctions/，当前：' + cfg.cloudfunctionRoot);
  } else {
    ok('cloudfunctionRoot', 'cloudfunctions/');
  }
  if (cfg.miniprogramRoot !== 'miniprogram/') {
    fail('miniprogramRoot', '应为 miniprogram/，当前：' + cfg.miniprogramRoot);
  } else {
    ok('miniprogramRoot', 'miniprogram/');
  }
})();

/* ---------- 2. 云环境配置 ---------- */
(function checkCloudEnv() {
  const p = path.join(MP, 'config.js');
  if (!exists(p)) {
    return fail('云环境配置', 'miniprogram/config.js 缺失');
  }
  const src = fs.readFileSync(p, 'utf8');
  const m = src.match(/cloudEnv\s*:\s*['"]([^'"]*)['"]/);
  if (!m) {
    return warn('云环境配置', '未能解析 cloudEnv 字段，请确认 config.js 结构');
  }
  const env = m[1].trim();
  if (!env) {
    ok('云环境配置', '留空 → 将使用小程序「默认环境」（单环境项目可直接跑）');
  } else if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(env)) {
    warn('云环境配置', '环境 ID 含异常字符：' + env);
  } else {
    ok('云环境配置', env);
  }
  // app.js 是否已改为读取配置
  const appSrc = fs.readFileSync(path.join(MP, 'app.js'), 'utf8');
  if (appSrc.indexOf("require('./config')") < 0) {
    warn('app.js', '未引用 config.js，可能仍写着硬编码环境 ID');
  } else {
    ok('app.js', '已接入 config.js 配置');
  }
})();

/* ---------- 3. 页面四件套 ---------- */
(function checkPages() {
  const appJson = path.join(MP, 'app.json');
  if (!exists(appJson)) return fail('app.json', '文件缺失');
  let app;
  try {
    app = readJSON(appJson);
  } catch (e) {
    return fail('app.json', 'JSON 解析失败：' + e.message);
  }

  const missing = [];
  (app.pages || []).forEach((page) => {
    ['.js', '.json', '.wxml'].forEach((ext) => {
      const f = path.join(MP, page + ext);
      if (!exists(f)) missing.push(page + ext);
    });
  });
  if (missing.length) {
    fail('页面文件完整性', '缺失：' + missing.join(', '));
  } else {
    ok('页面文件完整性', (app.pages || []).length + ' 个页面 × .js/.json/.wxml 齐全');
  }

  // tabBar 图标
  const list = (app.tabBar && app.tabBar.list) || [];
  const iconMissing = [];
  list.forEach((item) => {
    [item.iconPath, item.selectedIconPath].forEach((rel) => {
      if (rel && !exists(path.join(MP, rel))) iconMissing.push(rel);
    });
  });
  if (iconMissing.length) {
    fail('tabBar 图标', '缺失：' + iconMissing.join(', '));
  } else if (list.length) {
    ok('tabBar 图标', list.length + ' 个 tab × 2 态图标齐全');
  }

  // sitemap
  if (app.sitemapLocation && !exists(path.join(MP, app.sitemapLocation))) {
    fail('sitemap.json', 'app.json 引用了 ' + app.sitemapLocation + ' 但文件不存在');
  } else if (app.sitemapLocation) {
    ok('sitemap.json', app.sitemapLocation);
  }
})();

/* ---------- 4. 云函数 ---------- */
(function checkCloudFunctions() {
  if (!exists(CF)) return fail('cloudfunctions', '目录缺失');
  const dirs = fs
    .readdirSync(CF, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  if (!dirs.length) return fail('云函数', 'cloudfunctions 下没有任何云函数目录');

  const problems = [];
  dirs.forEach((name) => {
    const dir = path.join(CF, name);
    if (!exists(path.join(dir, 'index.js'))) {
      problems.push(name + ' 缺 index.js');
      return;
    }
    const pkgPath = path.join(dir, 'package.json');
    if (!exists(pkgPath)) {
      problems.push(name + ' 缺 package.json（云端安装依赖会失败）');
      return;
    }
    try {
      const pkg = readJSON(pkgPath);
      const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
      if (!deps['wx-server-sdk']) {
        problems.push(name + ' 未声明 wx-server-sdk 依赖');
      }
    } catch (e) {
      problems.push(name + ' 的 package.json 解析失败');
    }
  });

  if (problems.length) {
    fail('云函数结构', problems.join('；'));
  } else {
    ok('云函数结构', dirs.length + ' 个：' + dirs.join(', ') + '（依赖已声明）');
  }
})();

/* ---------- 5. 全量 JS 语法检查 ---------- */
(function checkSyntax() {
  const targets = [];
  function walk(dir, skip) {
    if (!exists(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
      if (skip.indexOf(ent.name) >= 0) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, skip);
      else if (ent.name.endsWith('.js')) targets.push(full);
    });
  }
  walk(MP, ['node_modules']);
  walk(CF, ['node_modules']);
  walk(path.join(ROOT, 'scripts'), []);
  walk(path.join(ROOT, 'tests'), []);

  const bad = [];
  targets.forEach((f) => {
    const src = fs.readFileSync(f, 'utf8');
    try {
      new vm.Script(src, { filename: f }); // 只编译不执行
    } catch (e) {
      bad.push(path.relative(ROOT, f) + ' → ' + e.message);
    }
  });

  if (bad.length) {
    fail('JS 语法', bad.length + ' 个文件有问题：\n      ' + bad.join('\n      '));
  } else {
    ok('JS 语法', targets.length + ' 个文件全部通过');
  }
})();

/* ---------- 6. 解析器可用性（真实 require 一次） ---------- */
(function checkParser() {
  const p = path.join(CF, 'menuParse', 'lib', 'parseExcel.js');
  if (!exists(p)) return fail('解析器', 'menuParse/lib/parseExcel.js 缺失');
  try {
    const mod = require(p);
    const fns = ['parseAOA'].filter((k) => typeof mod[k] === 'function');
    if (!fns.length) {
      warn('解析器', '模块可加载，但未导出 parseAOA —— 请确认导出名');
    } else {
      ok('解析器', '可加载并导出：' + Object.keys(mod).join(', '));
    }
  } catch (e) {
    fail('解析器', '加载失败：' + e.message);
  }
})();

/* ---------- 汇总 ---------- */
const ICON = { ok: '  OK   ', warn: ' WARN  ', fail: ' FAIL  ' };
const fails = checks.filter((c) => c.level === 'fail');
const warns = checks.filter((c) => c.level === 'warn');

console.log('\n好饭 · 部署前自检');
console.log('='.repeat(58));
checks.forEach((c) => {
  console.log('[' + ICON[c.level] + '] ' + c.name + (c.detail ? '  —— ' + c.detail : ''));
});
console.log('='.repeat(58));
console.log(
  '通过 ' +
    checks.filter((c) => c.level === 'ok').length +
    ' 项，警告 ' +
    warns.length +
    ' 项，阻断 ' +
    fails.length +
    ' 项\n'
);

if (fails.length) {
  console.log('还有 ' + fails.length + ' 项必须先处理，否则开发者工具里会报错：');
  fails.forEach((f) => console.log('  · ' + f.name + '：' + f.detail));
  process.exit(1);
} else if (warns.length) {
  console.log('没有阻断项，可以上传。上面的警告建议顺手看一眼。');
} else {
  console.log('全部通过，可以导入微信开发者工具了。');
}

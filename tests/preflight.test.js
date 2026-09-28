'use strict';

/**
 * 部署前自检（scripts/preflight.js）里「隐私接口清点」那一项的回归测试。
 *
 * 为什么要为一条「只是警告」的检查写测试：它是目前**唯一**能在提交前提醒你
 * 「提审别勾错隐私设置」的东西。这一项要是哪天被删了或映射表改漏了，
 * 不会有任何测试变红、也不会报错 —— 只会在发布后发现线上的复制/导入功能静默失效。
 *
 * 这类「不通则已、一通就炸」的护栏，必须自己有护栏。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const PREFLIGHT = fs.readFileSync(path.join(SCRIPTS, 'preflight.js'), 'utf8');

/**
 * 在隔离沙箱里跑一遍 preflight，把它的 console 输出收回来。
 *
 * 为什么不开子进程：Windows 沙箱下 spawnSync(node) 会 EBUSY，属于环境限制不是代码问题。
 * 沙箱执行还能顺带防住一件危险事 —— preflight 发现问题时会调 process.exit，
 * 真跑起来会把测试进程一起带走，所以这里传一个假的 process 进去。
 */
function runPreflight() {
  const lines = [];
  const sandbox = {
    require,
    __dirname: SCRIPTS,
    __filename: path.join(SCRIPTS, 'preflight.js'),
    module: { exports: {} },
    exports: {},
    console: { log: (...args) => lines.push(args.join(' ')) },
    process: {
      exit: () => {
        throw new Error('preflight 触发了 process.exit —— 说明出现了阻断项，需要先修');
      },
    },
  };
  vm.runInNewContext(PREFLIGHT, sandbox, { filename: 'preflight.js' });
  return lines.join('\n');
}

const cases = [];
const t = (name, fn) => cases.push({ name, fn });

t('preflight 的隐私映射表覆盖本项目实际用到的两个接口', () => {
  assert.ok(/api: 'setClipboardData', type: '读取你的剪切板'/.test(PREFLIGHT), '缺 setClipboardData → 读取你的剪切板');
  assert.ok(
    /api: 'getClipboardData', type: '读取你的剪切板'/.test(PREFLIGHT),
    'getClipboardData 也归在同一类，别漏'
  );
  assert.ok(
    /api: 'chooseMessageFile', type: '收集你选中的文件'/.test(PREFLIGHT),
    '缺 chooseMessageFile → 收集你选中的文件'
  );
});

t('★ 隐私检查真的把当前代码的 4 次调用报出来了（沙箱实跑）', () => {
  // 跑起来看输出，而不是只读源码：写得好看但跑不出来的检查项毫无价值
  const out = runPreflight();
  assert.ok(/隐私接口/.test(out), '自检输出里必须有「隐私接口」这一项');
  assert.ok(
    /4 次调用 \/ 2 个隐私类型/.test(out),
    '应报出 4 次调用 / 2 个隐私类型，实际输出见下：\n' + out
  );
  assert.ok(/setClipboardData×2@/.test(out), 'dish.js 里两处复制要如实计数');
  assert.ok(/chooseMessageFile×1@/.test(out), 'import.js 的选文件要报出来');
  assert.ok(/errno 112 \/ privacy api banned/.test(out), '警告里必须写清选错隐私设置的后果');
});

module.exports = cases;

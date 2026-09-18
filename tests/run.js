'use strict';

/**
 * 零依赖测试执行器。
 * 用法：npm test   （等价于 node tests/run.js）
 * 为什么不用 jest：解析器是本仓库唯一需要回归的核心，一个 20 行的执行器
 * 比一整套测试框架更适合单人项目，也保证 clone 下来不装任何依赖就能跑。
 */

const path = require('path');

const suites = [require('./parseExcel.test.js')];

let passed = 0;
let failed = 0;
const failures = [];

suites.forEach((cases, si) => {
  cases.forEach((c) => {
    try {
      c.fn();
      passed += 1;
      process.stdout.write('  \u001b[32m\u2713\u001b[0m ' + c.name + '\n');
    } catch (e) {
      failed += 1;
      failures.push({ name: c.name, error: e });
      process.stdout.write('  \u001b[31m\u2717\u001b[0m ' + c.name + '\n');
      process.stdout.write(
        '      ' + String(e && e.message ? e.message : e).split('\n').join('\n      ') + '\n'
      );
    }
  });
});

process.stdout.write('\n' + passed + ' passed, ' + failed + ' failed\n');

if (failed > 0) {
  process.stdout.write('\n失败用例：\n');
  failures.forEach((f) => process.stdout.write('  - ' + f.name + '\n'));
  process.exit(1);
}
process.exit(0);

// docs/tools/dead-service-scan.test.mjs — 死服务扫描闸的自测
//
// 依据：闸的判据必须**可证伪** —— 一个「怎么改都绿」的闸比没有闸更危险
//   （本仓 plan-block-audit 就吃过这个亏：正则写错 ⇒ 全部判成 D ⇒ 数字看着正常，没人发现判据本身是错的）。
//   ⇒ 本自测在**临时目录**里造假工程（**不依赖 platform 的真实代码内容**），
//     每个用例都构造「对/错」两种结果都能区分的断言。
//
// 用法：
//   node --disable-warning=ExperimentalWarning --test docs/tools/dead-service-scan.test.mjs
//   （⛔ 不要放进 platform/test/ —— 那里是平台的全量 `node --test` 目录）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { scanPlatform } from './dead-service-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, 'dead-service-scan.mjs');
const TEST_PATH = join(HERE, 'dead-service-scan.test.mjs');

/** 在临时目录里造一个假 platform 工程 */
function makeProject(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dead-service-scan-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

/** 扫一个假工程（允许清单固定用临时路径 ⇒ 不依赖仓库里那份 allow.json） */
function scan(dir, allowPath) {
  return scanPlatform(dir, { allowPath: allowPath || join(dir, '__no_allow__.json') });
}

const deadKeys = (result) => result.dead.map((d) => `${d.file}::${d.name}`);

// ══════════════════════════════════════════════════════════════════════
// 1. 有调用方的函数**不被**报死
// ══════════════════════════════════════════════════════════════════════
test('有生产调用方的函数不被报死', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function wiredFn() { return 1; }\n`,
    'src/http/routes/route.js': `import { wiredFn } from '../../services/alpha.js';
export function handler() { return wiredFn(); }
`,
  });
  try {
    const r = scan(dir);
    assert.ok(!deadKeys(r).includes('src/services/alpha.js::wiredFn'),
      `不该报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
    assert.equal(r.exported, 1);
    assert.equal(r.wired, 1);
    assert.equal(r.dead.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 2. 只在 platform/test/** 里被调用的函数**被**报死（本闸要抓的核心形态）
// ══════════════════════════════════════════════════════════════════════
test('只在 test/ 里被调用的函数被报死（被测了但没接线）', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function onlyTested() { return 1; }\n`,
    'test/alpha.test.js': `import { onlyTested } from '../src/services/alpha.js';
onlyTested();
`,
  });
  try {
    const r = scan(dir);
    assert.ok(deadKeys(r).includes('src/services/alpha.js::onlyTested'),
      `必须报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
    const hit = r.dead.find((d) => d.name === 'onlyTested');
    assert.ok(hit.tests.includes('test/alpha.test.js'),
      `排查提示里要指出是哪个测试调用过它，实际：${JSON.stringify(hit.tests)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 3. 注释 / 字符串里的名字**不算调用**
// ══════════════════════════════════════════════════════════════════════
test('只在注释与字符串里出现的函数名不算调用 ⇒ 报死', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function mentionedOnly() { return 1; }\n`,
    'src/http/routes/route.js': `import { mentionedOnly } from '../../services/alpha.js';
// mentionedOnly(1) —— 注释里的假调用
const s = "mentionedOnly(2)";
const t = \`mentionedOnly(3)\`;
export function handler() { return s + t; }
`,
  });
  try {
    const r = scan(dir);
    assert.ok(deadKeys(r).includes('src/services/alpha.js::mentionedOnly'),
      `注释/字符串里的名字不算调用 ⇒ 必须报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('既有真实调用、又被注释/字符串提到 ⇒ 不报死（提及不能制造假调用）', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function both() { return 1; }\n`,
    'src/http/routes/route.js': `import { both } from '../../services/alpha.js';
// both(1) 注释里也提到它
export function handler() { return both(); }
`,
  });
  try {
    const r = scan(dir);
    assert.ok(!deadKeys(r).includes('src/services/alpha.js::both'),
      `有真实调用就不该报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 4. 同名不同源：必须按「定义所在文件」精确归属
// ══════════════════════════════════════════════════════════════════════
test('同名不同源：只有 B 的调用点 ⇒ A 的同名函数报死，B 的不报死', () => {
  const dir = makeProject({
    'src/services/a.js': `export function foo() { return 'a'; }\n`,
    'src/services/b.js': `export function foo() { return 'b'; }\n`,
    'src/http/routes/route.js': `import { foo } from '../../services/b.js';
export function handler() { return foo(); }
`,
  });
  try {
    const r = scan(dir);
    assert.ok(deadKeys(r).includes('src/services/a.js::foo'),
      `A 的 foo 没有调用方 ⇒ 必须报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
    assert.ok(!deadKeys(r).includes('src/services/b.js::foo'),
      `B 的 foo 有调用方 ⇒ 不该报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同名不同源：两个同名函数各自都有调用方 ⇒ 都不报死', () => {
  const dir = makeProject({
    'src/services/a.js': `export function foo() { return 'a'; }\n`,
    'src/services/b.js': `export function foo() { return 'b'; }\n`,
    'src/http/routes/route.js': `import { foo as fooA } from '../../services/a.js';
import { foo as fooB } from '../../services/b.js';
export function handler() { return fooA() + fooB(); }
`,
  });
  try {
    const r = scan(dir);
    assert.equal(r.dead.length, 0, `两个都有调用方，不该有死函数，实际：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 5. 允许清单生效
// ══════════════════════════════════════════════════════════════════════
test('允许清单生效：命中的函数不报死，并出现在「允许清单」一节', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function exempt() { return 1; }\nexport function notExempt() { return 2; }\n`,
  });
  const allowPath = join(dir, 'allow.json');
  writeFileSync(allowPath, JSON.stringify({
    allow: [{ file: 'src/services/alpha.js', name: 'exempt', reason: '纯工具函数，只在同文件内部用' }],
  }), 'utf8');
  try {
    const r = scan(dir, allowPath);
    assert.ok(!deadKeys(r).includes('src/services/alpha.js::exempt'),
      `豁免项不该报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
    assert.ok(deadKeys(r).includes('src/services/alpha.js::notExempt'),
      `没豁免的必须报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
    const allowed = r.allowed.find((a) => a.name === 'exempt');
    assert.ok(allowed, '豁免项必须出现在允许清单一节');
    assert.equal(allowed.file, 'src/services/alpha.js');
    assert.equal(allowed.reason, '纯工具函数，只在同文件内部用');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 6. 退出码
// ══════════════════════════════════════════════════════════════════════
test('退出码：有死函数 ⇒ 1；没有 ⇒ 0', () => {
  const deadDir = makeProject({
    'src/services/alpha.js': `export function deadOne() { return 1; }\n`,
  });
  const cleanDir = makeProject({
    'src/services/alpha.js': `export function aliveOne() { return 1; }\n`,
    'src/http/routes/route.js': `import { aliveOne } from '../../services/alpha.js';
export function handler() { return aliveOne(); }
`,
  });
  try {
    const rDead = spawnSync(process.execPath, [SCRIPT_PATH, deadDir], { encoding: 'utf8' });
    assert.equal(rDead.status, 1, `有死函数时退出码必须是 1，实际 ${rDead.status}\n${rDead.stdout}\n${rDead.stderr}`);
    const rClean = spawnSync(process.execPath, [SCRIPT_PATH, cleanDir], { encoding: 'utf8' });
    assert.equal(rClean.status, 0, `没有死函数时退出码必须是 0，实际 ${rClean.status}\n${rClean.stdout}\n${rClean.stderr}`);
    // 允许清单豁免之后 ⇒ 也应该是 0
    const allowPath = join(deadDir, 'allow.json');
    writeFileSync(allowPath, JSON.stringify({
      allow: [{ file: 'src/services/alpha.js', name: 'deadOne', reason: '豁免' }],
    }), 'utf8');
    const rAllowed = spawnSync(process.execPath, [SCRIPT_PATH, '--allow', allowPath, deadDir], { encoding: 'utf8' });
    assert.equal(rAllowed.status, 0, `豁免之后退出码必须是 0，实际 ${rAllowed.status}\n${rAllowed.stdout}`);
  } finally {
    rmSync(deadDir, { recursive: true, force: true });
    rmSync(cleanDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 7. --json 输出结构
// ══════════════════════════════════════════════════════════════════════
test('--json 输出结构合法（能 JSON.parse，且含 dead 数组）', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function deadOne() { return 1; }\nexport function aliveOne() { return 2; }\n`,
    'src/http/routes/route.js': `import { aliveOne } from '../../services/alpha.js';
export function handler() { return aliveOne(); }
`,
  });
  try {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--json', dir], { encoding: 'utf8' });
    assert.equal(r.status, 1, `有死函数时退出码是 1，实际 ${r.status}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.scannedFiles, 1);
    assert.equal(out.exported, 2);
    assert.equal(out.wired, 1);
    assert.ok(Array.isArray(out.dead), 'dead 必须是数组');
    assert.equal(out.dead.length, 1);
    assert.equal(out.dead[0].file, 'src/services/alpha.js');
    assert.equal(out.dead[0].name, 'deadOne');
    assert.ok(Array.isArray(out.allowed), 'allowed 必须是数组');
    assert.ok(Array.isArray(out.undetermined), 'undetermined 必须是数组');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 8. 间接 re-export：调用方 import 的是再导出的那个文件，也要算数
// ══════════════════════════════════════════════════════════════════════
test('间接 re-export：调用方 import 的是再导出文件 ⇒ 不报死', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function reExported() { return 1; }\n`,
    'src/services/index.js': `export { reExported } from './alpha.js';\n`,
    'src/http/routes/route.js': `import { reExported } from '../../services/index.js';
export function handler() { return reExported(); }
`,
  });
  try {
    const r = scan(dir);
    assert.ok(!deadKeys(r).includes('src/services/alpha.js::reExported'),
      `追得到 re-export 链就不该报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 9. 同名遮蔽：被内层作用域遮蔽的调用不算数 ⇒ 进「无法判定」
// ══════════════════════════════════════════════════════════════════════
test('同名遮蔽：被内层作用域重新声明的调用不算数 ⇒ 报死并进「无法判定」', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function shadowed() { return 1; }\n`,
    'src/http/routes/route.js': `import { shadowed } from '../../services/alpha.js';
export function handler() {
  const shadowed = () => 2;
  return shadowed();
}
`,
  });
  try {
    const r = scan(dir);
    assert.ok(deadKeys(r).includes('src/services/alpha.js::shadowed'),
      `遮蔽掉的调用不算生产调用方 ⇒ 必须报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
    assert.ok(r.undetermined.length > 0, '遮蔽必须进「无法判定」一节');
    assert.ok(r.undetermined.some((u) => u.name === 'shadowed'),
      `无法判定里要能看到被遮蔽的名字，实际：${JSON.stringify(r.undetermined)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 10. 只认「导出的函数」：class / default / 非函数常量都不算目标
// ══════════════════════════════════════════════════════════════════════
test('export class / export default / 非函数常量都不算「导出的函数」', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export class Thing {}\nexport default function () {}\nexport const CONST = 42;\nexport const fn = (x) => x;\n`,
  });
  try {
    const r = scan(dir);
    assert.equal(r.exported, 1, `只有 export const fn = (…) => 算导出的函数，实际 ${r.exported}`);
    assert.deepEqual(deadKeys(r), ['src/services/alpha.js::fn'], 'fn 没有调用方 ⇒ 应当报死');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 11. 命名空间导入 obj.foo(...) 算调用；普通对象的同名属性不算
// ══════════════════════════════════════════════════════════════════════
test('命名空间导入的成员调用算调用；普通对象的同名属性键不算', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function nsMember() { return 1; }\n`,
    'src/http/routes/route.js': `import * as svc from '../../services/alpha.js';
export function handler() {
  const obj = { nsMember: 1 };
  return svc.nsMember() + obj.nsMember;
}
`,
  });
  try {
    const r = scan(dir);
    assert.ok(!deadKeys(r).includes('src/services/alpha.js::nsMember'),
      `svc.nsMember() 是真调用 ⇒ 不该报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只有对象字面量的同名属性键 ⇒ 报死（属性键不是调用）', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function keyOnly() { return 1; }\n`,
    'src/http/routes/route.js': `import { keyOnly } from '../../services/alpha.js';
export function handler() {
  const obj = { keyOnly: 1 };
  return obj.keyOnly;
}
`,
  });
  try {
    const r = scan(dir);
    assert.ok(deadKeys(r).includes('src/services/alpha.js::keyOnly'),
      `对象属性键不是调用 ⇒ 必须报死，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 12. foo.call(...) / foo.apply(...) 也算调用
// ══════════════════════════════════════════════════════════════════════
test('foo.call(...) / foo.apply(...) 算调用', () => {
  const dir = makeProject({
    'src/services/alpha.js': `export function viaCall() { return 1; }\nexport function viaApply() { return 2; }\n`,
    'src/http/routes/route.js': `import { viaCall, viaApply } from '../../services/alpha.js';
export function handler() {
  return viaCall.call(null) + viaApply.apply(null);
}
`,
  });
  try {
    const r = scan(dir);
    assert.equal(r.dead.length, 0, `call/apply 都是调用，实际死清单：${JSON.stringify(deadKeys(r))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 13. 领域层不参与「导出函数」统计（只扫 services/ 与 db/repo/）
// ══════════════════════════════════════════════════════════════════════
test('只扫 services/ 与 db/repo/：domain/ 里的导出函数不进统计', () => {
  const dir = makeProject({
    'src/domain/pure.js': `export function pureFn() { return 1; }\n`,
    'src/services/alpha.js': `export function svcFn() { return 1; }\n`,
  });
  try {
    const r = scan(dir);
    assert.equal(r.exported, 1, `只该统计 services/ 里的 svcFn，实际 ${r.exported}`);
    assert.ok(!deadKeys(r).some((k) => k.includes('domain/')), 'domain/ 的函数不该进死清单');
    assert.ok(deadKeys(r).includes('src/services/alpha.js::svcFn'), 'svcFn 没有调用方 ⇒ 应报死');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 变异检验：把「只是提到名字」也算成调用 ⇒ 自测必须变红
// ══════════════════════════════════════════════════════════════════════
// ⚠️ 这个用例会**再跑一遍整套自测**（跑在变异版脚本上）。
//    子进程用 DEAD_SCAN_MUTATION_CHILD=1 标记，避免无限递归。
test('变异检验：「只是提到名字」也算调用 ⇒ 整套自测必须变红', (t) => {
  if (process.env.DEAD_SCAN_MUTATION_CHILD === '1') {
    t.skip('变异子进程里不再递归跑变异检验');
    return;
  }
  // ⚠️ 变异点必须**真的破坏「调用点识别」**：
  //    变异①：词法层不再剥离行注释 ⇒ 注释里的 `foo(...)` 被当成真调用；
  //    变异②：字符串内容也被当成代码 ⇒ 字符串里的 `foo(...)` 也被当成真调用。
  //    （只把「值引用」当调用是不够的：注释/字符串压根不产生 token ⇒ 那样变异不到点子上。）
  //    ⚠️ 变异②保留原来的 str token：不然 import 的来源就解析不出来了，
  //       那样整套用例会因为「另一个原因」变红 ⇒ 变异检验就失去意义（红得不对口）。
  const MUTATIONS = [
    [
      "if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\\n') i++; continue; }",
      "if (ch === '/' && src[i + 1] === '/') { i += 2; continue; }",
    ],
    [
      "push('str', src.slice(start + 1, Math.max(start + 1, i - 1)), start, i);",
      "push('str', src.slice(start + 1, Math.max(start + 1, i - 1)), start, i); for (const tk of tokenize(src.slice(start + 1, Math.max(start + 1, i - 1)))) tokens.push(tk);",
    ],
  ];

  const dir = mkdtempSync(join(tmpdir(), 'dead-service-scan-mut-'));
  try {
    const src = readFileSync(SCRIPT_PATH, 'utf8');
    let mutated = src;
    for (const [from, to] of MUTATIONS) {
      assert.ok(mutated.includes(from), `变异点必须真实存在于脚本里（否则变异检验是假的）：${from}`);
      mutated = mutated.replace(from, to);
    }
    assert.notEqual(mutated, src, '变异必须真的改动了脚本');
    writeFileSync(join(dir, 'dead-service-scan.mjs'), mutated, 'utf8');

    // 自测副本放在同一目录 ⇒ 它的相对 import 指向变异版脚本
    const testSrc = readFileSync(TEST_PATH, 'utf8');
    writeFileSync(join(dir, 'dead-service-scan.test.mjs'), testSrc, 'utf8');

    const r = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--test', join(dir, 'dead-service-scan.test.mjs')],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DEAD_SCAN_MUTATION_CHILD: '1',
          // ⛔ 必须去掉 NODE_TEST_CONTEXT：带着它，Node 的测试运行器会认为
          //    「自己被另一个测试运行器递归调用」⇒ 直接跳过执行 ⇒ 退出码 0（假绿）。
          NODE_TEST_CONTEXT: undefined,
        },
      },
    );
    assert.notEqual(r.status, 0,
      `变异后自测必须变红，实际退出码 ${r.status}\n${r.stdout}\n${r.stderr}`);
    // 至少要看到「注释/字符串里的名字不算调用」这条用例挂掉
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(/not ok \d+ - 只在注释与字符串里出现的函数名不算调用/.test(out),
      `变异后应当是「注释/字符串不算调用」那条用例红了，实际输出：\n${out.slice(0, 4000)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

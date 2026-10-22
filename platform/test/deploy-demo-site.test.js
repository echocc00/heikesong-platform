import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const deployDir = join(here, '..', 'deploy');

function read(name) {
  return readFileSync(join(deployDir, name), 'utf8');
}

/** 去掉整行注释，只留真正参与配置语义的行（与其它部署测试同款口径）。 */
function effective(text) {
  return String(text).split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
}

// ── 沙箱：source deploy-demo-site.sh 并调用指定函数 ────────────────────
function runDemo(body, env = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'heikesong-demo-'));
  try {
    const binDir = join(tmp, 'bin');
    mkdirSync(binDir, { recursive: true });
    // node 桩：记录调用参数，并按 --out 造出产物（index.html）
    const nodeLog = join(tmp, 'node.log');
    writeFileSync(
      join(binDir, 'node'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${nodeLog}"\n`
      + 'out=""\nprev=""\nfor a in "$@"; do if [ "$prev" = "--out" ]; then out="$a"; fi; prev="$a"; done\n'
      + 'if [ -n "$out" ]; then mkdir -p "$out"; printf "<html>demo</html>" > "$out/index.html"; fi\nexit 0\n',
    );
    chmodSync(join(binDir, 'node'), 0o755);
    // nginx 桩：-t 一律成功（要测失败路径用 HKS_NGINX_T_FAIL=1）
    writeFileSync(
      join(binDir, 'nginx'),
      `#!/bin/sh\nif [ "$1" = "-t" ] && [ -n "${env.HKS_NGINX_T_FAIL || ''}" ]; then echo "nginx: [emerg] 模拟的配置错误" >&2; exit 1; fi\n`
      + 'if [ "$1" = "-v" ]; then echo "nginx version: nginx/1.22.1 (Ubuntu)" >&2; fi\nexit 0\n',
    );
    chmodSync(join(binDir, 'nginx'), 0o755);
    // systemctl 桩：reload / restart 都成功
    writeFileSync(join(binDir, 'systemctl'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binDir, 'systemctl'), 0o755);
    // curl 桩：打印状态码（HKS_CURL_CODE 可指定，用来测「站点不可取」）
    writeFileSync(join(binDir, 'curl'), `#!/bin/sh\necho "${env.HKS_CURL_CODE || '200'}"\n`);
    chmodSync(join(binDir, 'curl'), 0o755);

    // 假证书（脚本会检查它们存在）
    const cert = join(tmp, 'fullchain.pem');
    const key = join(tmp, 'privkey.pem');
    writeFileSync(cert, 'fake-cert');
    writeFileSync(key, 'fake-key');

    // 假平台源码目录（build_demo 要求 scripts/build-demo.js 存在）
    const appDir = join(tmp, 'app');
    mkdirSync(join(appDir, 'scripts'), { recursive: true });
    writeFileSync(join(appDir, 'scripts', 'build-demo.js'), '// stub');

    // 去掉末尾的 `main "$@"`（否则一 source 就真的跑主流程：撞 root 检查 + 改机器状态）
    const stripped = join(tmp, 'deploy-demo-site.sh');
    writeFileSync(stripped, read('deploy-demo-site.sh').replace(/^main "\$@"$/m, ':'));

    const script = [
      'set -uo pipefail',
      `export PATH="${binDir}:$PATH"`,
      `source "${stripped}"`,
      // ⚠️ 覆盖必须在 source **之后**做：脚本在 source 时就把变量固化成了自己的默认值。
      `SERVER_NAME="${env.HKS_SERVER_NAME ?? '8.133.200.235'}"`,
      `CERT_PATH="${cert}"`,
      `KEY_PATH="${key}"`,
      `APP_DIR="${appDir}"`,
      `DEMO_DIR="${env.HKS_DEMO_DIR === 'INSIDE' ? join(appDir, 'demo') : (env.HKS_DEMO_DIR ?? join(tmp, 'demo'))}"`,
      `DEMO_PORT="${env.HKS_DEMO_PORT ?? '8445'}"`,
      `NGINX_SITE="${join(tmp, 'etc/nginx/sites-available/heikesong-demo.conf')}"`,
      `NGINX_LINK="${join(tmp, 'etc/nginx/sites-enabled/heikesong-demo.conf')}"`,
      `NGINX_TEMPLATE="${env.HKS_TEMPLATE ?? join(deployDir, 'nginx-demo-static.conf')}"`,
      // ⚠️ 必须指向**真实的**兼容脚本：沙箱里的脚本副本旁边没有它
      //    （SCRIPT_DIR 指向临时目录）⇒ write_site 会直接 die。
      `NGINX_COMPAT_SCRIPT="${join(deployDir, 'nginx-http2-compat.sh')}"`,
      `SKIP_BUILD="${env.HKS_SKIP_BUILD ?? ''}"`,
      'mkdir -p "$(dirname "$NGINX_SITE")" "$(dirname "$NGINX_LINK")"',
      'set +e',
      body,
    ].join('\n');

    const res = spawnSync('bash', ['-c', script], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
    return {
      code: res.status,
      out: `${res.stdout || ''}${res.stderr || ''}`,
      siteText: readIf(join(tmp, 'etc/nginx/sites-available/heikesong-demo.conf')),
      linkPath: join(tmp, 'etc/nginx/sites-enabled/heikesong-demo.conf'),
      linkExists: existsSync(join(tmp, 'etc/nginx/sites-enabled/heikesong-demo.conf')),
      nodeLog: readIf(nodeLog) || '',
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 模板的硬约束 ──────────────────────────────────────────────────────

test('演示站模板存在：deploy/nginx-demo-static.conf', () => {
  assert.ok(existsSync(join(deployDir, 'nginx-demo-static.conf')), '演示站模板必须存在');
});

test('⛔ 演示站模板必须**纯静态**：不得出现 proxy_pass / upstream', () => {
  const conf = effective(read('nginx-demo-static.conf'));
  assert.ok(!/proxy_pass/.test(conf), '⛔ 演示站不得代理任何后端（那会让它退化成平台的第二个入口、origin 隔离失效）');
  assert.ok(!/upstream\s+\w+\s*\{/.test(conf), '⛔ 演示站不得定义 upstream');
  assert.ok(!/127\.0\.0\.1:8080/.test(conf), '⛔ 不得指向平台后端端口');
});

test('演示站模板：占位符齐全（端口 / server_name / 证书 / 静态包目录）', () => {
  const conf = effective(read('nginx-demo-static.conf'));
  assert.match(conf, /listen __TLS_PORT__ ssl;/, '必须监听占位符端口并挂 TLS');
  assert.match(conf, /listen \[::\]:__TLS_PORT__ ssl;/, 'IPv6 那一支也要挂');
  assert.match(conf, /server_name __SERVER_NAME__;/, '必须有 server_name 占位');
  assert.match(conf, /ssl_certificate\s+__CERT_PATH__;/, '必须有证书占位');
  assert.match(conf, /ssl_certificate_key\s+__KEY_PATH__;/, '必须有私钥占位');
  assert.match(conf, /root __DEMO_DIR__;/, '必须有静态包目录占位');
  assert.match(conf, /index index\.html;/, '必须指定首页');
});

test('演示站模板：找不到就 404（不列目录），入口页不缓存', () => {
  const conf = effective(read('nginx-demo-static.conf'));
  assert.match(conf, /try_files \$uri \$uri\/ =404;/, '必须用 try_files（不列目录、找不到返 404）');
  assert.match(conf, /add_header Cache-Control "no-cache" always;/, '入口页必须不缓存（演示站会随代码迭代重发）');
});

// ── 脚本的硬约束 ──────────────────────────────────────────────────────

test('发布脚本存在：deploy/deploy-demo-site.sh', () => {
  assert.ok(existsSync(join(deployDir, 'deploy-demo-site.sh')), '发布脚本必须存在');
});

test('发布脚本：⛔ DEMO_DIR 不得在 APP_DIR 内部（会被 install.sh 的 rsync --delete 删掉）', () => {
  const sh = read('deploy-demo-site.sh');
  assert.match(sh, /"\$APP_DIR"\|\"\$APP_DIR"\/\*\)/, '必须挡住 DEMO_DIR 在 APP_DIR 内部的情况');
});

test('发布脚本：⛔ 不得碰平台本体的站点文件', () => {
  const sh = effective(read('deploy-demo-site.sh'));
  assert.ok(!/heikesong\.conf/.test(sh), '⛔ 不得写平台的站点文件（演示站发布失败不能影响平台对外）');
  assert.ok(!/heikesong-tls\.conf/.test(sh), '⛔ 不得写平台的 TLS 站点文件');
});

// ── 沙箱实跑 ──────────────────────────────────────────────────────────

test('沙箱实跑：渲染出的演示站站点 = 端口 / root / 证书全对，且占位符零残留', () => {
  const r = runDemo('write_site');
  assert.equal(r.code, 0, `写站点应成功，实际输出：\n${r.out}`);
  const site = effective(r.siteText || '');
  assert.match(site, /listen 8445 ssl/, `必须监听 8445，实际：\n${site.slice(0, 300)}`);
  assert.match(site, /root \/.*\/demo;/, 'root 必须指向静态包目录');
  assert.match(site, /ssl_certificate\s+.*fullchain\.pem;/, '证书路径必须替换');
  assert.ok(!/__[A-Z_]+__/.test(site), `占位符必须零残留，实际：\n${site}`);
  assert.ok(!/proxy_pass/.test(site), '⛔ 渲染结果里不得出现 proxy_pass');
  assert.ok(r.linkExists, '软链必须建好');
});

test('⛔ 渲染前必须过 HTTP/2 兼容层（老 nginx 不认 `http2 on;`，会直接让整个 nginx 起不来）', () => {
  const r = runDemo('write_site');
  assert.equal(r.code, 0, `写站点应成功，实际输出：\n${r.out}`);
  const site = effective(r.siteText || '');
  assert.match(site, /listen 8445 ssl http2;/, '⛔ 老版本 nginx 必须降级成 `listen <端口> ssl http2;`');
  assert.ok(!/http2 on;/.test(site), '⛔ 不得残留独立的 `http2 on;`（该 nginx 版本不认这个指令 ⇒ nginx -t 失败）');
});

test('沙箱实跑：构建步骤会用 --out 把产物指到 DEMO_DIR', () => {
  const r = runDemo('build_demo');
  assert.equal(r.code, 0, `构建应成功，实际输出：\n${r.out}`);
  assert.match(r.nodeLog, /scripts\/build-demo\.js --out /, `必须调用 build-demo.js 并带 --out，实际：\n${r.nodeLog}`);
  assert.match(r.nodeLog, /\/demo\b/, `--out 必须指向 DEMO_DIR，实际：\n${r.nodeLog}`);
});

test('沙箱实跑：nginx -t 失败 ⇒ 必须回滚（撤销站点文件与软链）', () => {
  const r = runDemo('write_site', { HKS_NGINX_T_FAIL: '1' });
  assert.notEqual(r.code, 0, 'nginx -t 失败必须非 0 退出');
  assert.match(r.out, /已撤销本次演示站配置/, '应当明确说已撤销');
  assert.equal(r.siteText, null, '⛔ 坏配置不许留在 sites-available 里');
  assert.equal(r.linkExists, false, '⛔ 软链必须一并撤销');
});

test('沙箱实跑：站点取不到内容 ⇒ 校验必须失败并说人话', () => {
  const r = runDemo('verify_site', { HKS_CURL_CODE: '404' });
  assert.notEqual(r.code, 0, '校验失败必须非 0 退出');
  assert.match(r.out, /演示站校验未通过/, '要说清是校验未通过');
});

test('沙箱实跑：前置校验必须 fail-fast 且说人话', () => {
  // 缺 SERVER_NAME
  let r = runDemo('validate', { HKS_SERVER_NAME: '' });
  assert.notEqual(r.code, 0, '缺 SERVER_NAME 必须非 0 退出');
  assert.match(r.out, /SERVER_NAME/, '报错要说清是 SERVER_NAME');

  // ⛔ DEMO_DIR 在 APP_DIR 内部（**行为**断言：光看文本的话，把守卫换成 `: ;;` 也能骗过）
  r = runDemo('validate', { HKS_DEMO_DIR: 'INSIDE' });
  assert.notEqual(r.code, 0, '⛔ DEMO_DIR 落在 APP_DIR 内部必须非 0 退出（产物会被镜像同步清掉）');
  assert.match(r.out, /DEMO_DIR/, '报错要说清是 DEMO_DIR');

  // 端口非法
  for (const bad of ['abc', '0', '70000']) {
    r = runDemo('validate', { HKS_DEMO_PORT: bad });
    assert.notEqual(r.code, 0, `端口 ${bad} 必须非 0 退出`);
    assert.match(r.out, /DEMO_PORT/, `报错要说清是 DEMO_PORT（实际 ${bad}）`);
  }
});

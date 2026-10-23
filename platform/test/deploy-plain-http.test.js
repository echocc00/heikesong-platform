import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { isolateTempDir } from '../test-helpers/tmp.js';
import { call } from '../test-helpers/http-call.js';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createUser } from '../src/db/repo/users.js';
import { createApp } from '../src/server.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const deployDir = join(here, '..', 'deploy');
const srcDir = join(here, '..', 'src');

function read(name) {
  return readFileSync(join(deployDir, name), 'utf8');
}

function readSrc(name) {
  return readFileSync(join(srcDir, name), 'utf8');
}

/** 去掉整行注释，只留真正参与配置语义的行（与 deploy-assets.test.js 同款口径）。 */
function effective(text) {
  return String(text).split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
}

// ── 沙箱：在临时目录里 source install.sh 并调用指定函数 ──────────────────
// ⚠️ 为什么不在这里复用 deploy-assets.test.js 的 runInstallShell：
//    那边要覆盖「nginx -t 失败回滚」「软链还原」等一整套矩阵；
//    这里只需要跑两个函数（write_env_file / write_nginx_site）并检查产物。
//    两边需求不同 ⇒ 不强行合并（等出现第三处再抽公共 helper）。
function runInstall(body, env = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'heikesong-plain-'));
  try {
    // 去掉末尾的 `main "$@"`（否则它会去改机器状态）
    writeFileSync(join(tmp, 'install.sh'), read('install.sh').replace(/^main "\$@"$/m, ''));

    const binDir = join(tmp, 'bin');
    mkdirSync(binDir, { recursive: true });
    // nginx 桩：`-v` 打印版本（compat 脚本要探测），`-t` 一律通过
    writeFileSync(
      join(binDir, 'nginx'),
      '#!/bin/sh\nif [ "$1" = "-v" ]; then echo "nginx version: nginx/1.24.0 (Ubuntu)" >&2; exit 0; fi\nexit 0\n',
    );
    chmodSync(join(binDir, 'nginx'), 0o755);
    // systemctl 桩：reload / restart 都成功（否则写站点那步会以非 0 退出）
    writeFileSync(join(binDir, 'systemctl'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binDir, 'systemctl'), 0o755);
    // ⚠️ 必须给 `rm` 打个桩（deploy-assets.test.js 里早有先例，此处补齐）：
    //    某些开发环境把 `rm` shim 成「可恢复删除」（走 osascript + Finder）⇒
    //    ① 每次删除要好几秒；
    //    ② 目标落在系统临时区时，**访达会弹管理员授权框**，osascript 被模态框
    //       阻塞住不返回 ⇒ 命令挂死、整轮测试被拖成分钟级；
    //    ③ 每轮测试都新建一个同名临时目录 ⇒ 弹窗一轮一个地反复出现，
    //       删文件也删不掉（下一轮又造一个新的同名文件）。
    //    这里让桩直接调**真正的** /bin/rm：被测的是**逻辑**（回滚删没删对东西），
    //    不是「删除是否可恢复」。
    const realRm = ['/bin/rm', '/usr/bin/rm'].find((p) => existsSync(p)) || 'rm';
    const rmStub = join(binDir, 'rm');
    writeFileSync(rmStub, `#!/bin/sh\nexec ${realRm} "$@"\n`);
    chmodSync(rmStub, 0o755);

    const script = [
      'set -uo pipefail',
      `export PATH="${binDir}:$PATH"`,
      `export NGINX_SITE="${tmp}/etc/nginx/sites-available/heikesong.conf"`,
      `export NGINX_LINK="${tmp}/etc/nginx/sites-enabled/heikesong.conf"`,
      'export SERVER_NAME="8.133.200.235"',
      `export APP_DIR="${tmp}/app"`,
      `export DATA_DIR="${tmp}/data"`,
      `export ENV_FILE="${tmp}/platform.env"`,
      'mkdir -p "$(dirname "$NGINX_SITE")" "$(dirname "$NGINX_LINK")"',
      `source "${tmp}/install.sh"`,
      // source 之后 SCRIPT_DIR/ROOT 是按 $0 算的（source 时 $0 是 bash）⇒ 必须改回来
      `SCRIPT_DIR="${deployDir}"`,
      `ROOT="${join(here, '..')}"`,
      `NGINX_COMPAT_SCRIPT="${deployDir}/nginx-http2-compat.sh"`,
      // ⚠️ 覆盖必须在 source **之后**做：install.sh 在被 source 时就把
      //    NGINX_TEMPLATE / NGINX_HTTP_PORT / COOKIE_SECURE 固化成了自己的值。
      //    用 HKS_* 前缀，避免和 install.sh 自己的变量名撞车。
      `NGINX_TEMPLATE="${env.HKS_TEMPLATE || join(deployDir, 'nginx-plain-http.conf')}"`,
      `NGINX_HTTP_PORT="${env.HKS_HTTP_PORT || '8081'}"`,
      `COOKIE_SECURE="${env.HKS_COOKIE_SECURE || ''}"`,
      'set +e',
      body,
    ].join('\n');

    const res = spawnSync('bash', ['-c', script], {
      env: { ...process.env, HKS_TMP: tmp, ...env },
      encoding: 'utf8',
    });
    // ⚠️ 产物必须在**清理之前**读出来（finally 里会把沙箱删掉）。
    const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
    return {
      code: res.status,
      out: `${res.stdout || ''}${res.stderr || ''}`,
      siteText: readIf(join(tmp, 'etc/nginx/sites-available/heikesong.conf')),
      envText: readIf(join(tmp, 'platform.env')),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('让路模板存在：deploy/nginx-plain-http.conf', () => {
  assert.ok(existsSync(join(deployDir, 'nginx-plain-http.conf')), '让路形态模板必须存在');
});

test('让路模板：只监听自定义 HTTP 端口，⛔ 不含 TLS、⛔ 不做 HTTP→HTTPS 跳转', () => {
  const conf = effective(read('nginx-plain-http.conf'));
  assert.match(conf, /listen __HTTP_PORT__;/, '必须用占位符占位（端口由 install.sh 注入）');
  assert.ok(!/\bssl\b/.test(conf), '让路模板**不得**含 ssl（本机 443 被占）');
  assert.ok(!/return 301/.test(conf), '让路模板**不得**跳转到 https（没有 443 可跳）');
  assert.ok(!/ssl_certificate/.test(conf), '让路模板**不得**引用证书');
});

test('让路模板：上游口径与正式模板一致（127.0.0.1:8080），且保住 SSE 与真实 IP', () => {
  const conf = effective(read('nginx-plain-http.conf'));
  assert.match(conf, /server 127\.0\.0\.1:8080;/, '上游必须是 127.0.0.1:8080（与应用端口口径同一套）');
  assert.match(conf, /proxy_buffering off;/, 'SSE 必须关缓冲');
  assert.match(conf, /add_header X-Accel-Buffering no;/, 'SSE 必须发 X-Accel-Buffering: no');
  assert.match(conf, /proxy_set_header X-Real-IP \$remote_addr;/, '必须透传真实客户端 IP（审计要读）');
  assert.match(conf, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/, '必须透传 X-Forwarded-For');
});

test('install.sh：三个新开关都在，且默认值合理', () => {
  const sh = read('install.sh');
  assert.match(sh, /NGINX_TEMPLATE="\$\{NGINX_TEMPLATE:-\$ROOT\/deploy\/nginx\.conf\}"/, '默认模板必须是正式那份（域名+TLS）');
  assert.match(sh, /NGINX_HTTP_PORT="\$\{NGINX_HTTP_PORT:-8081\}"/, '默认 HTTP 端口 8081');
  assert.match(sh, /COOKIE_SECURE="\$\{COOKIE_SECURE:-\}"/, 'COOKIE_SECURE 默认不设 = 跟随 NODE_ENV');
  assert.match(sh, /__HTTP_PORT__/, 'install.sh 必须替换 __HTTP_PORT__ 占位符');
  assert.match(sh, /"\$NGINX_TEMPLATE"/, 'install.sh 必须用 NGINX_TEMPLATE（而不是写死 deploy/nginx.conf）');
});

test('沙箱实跑：用让路模板渲染出的站点 = 8081 端口、无 443、占位符零残留', () => {
  const r = runInstall('write_nginx_site');
  assert.equal(r.code, 0, `渲染应成功，实际输出：\n${r.out}`);
  const site = effective(r.siteText || '');
  assert.match(site, /listen 8081;/, `必须监听 8081，实际：\n${site.slice(0, 400)}`);
  assert.ok(!/listen 443/.test(site), '⛔ 不得监听 443');
  assert.ok(!/__[A-Z_]+__/.test(site), '占位符必须零残留');
  assert.match(site, /server_name 8\.133\.200\.235;/, 'server_name 应替换成传入的 SERVER_NAME');
});

test('沙箱实跑：正式模板（默认）仍然是 80 + 443 + TLS（让路开关没改默认行为）', () => {
  const r = runInstall('write_nginx_site', { HKS_TEMPLATE: join(deployDir, 'nginx.conf') });
  assert.equal(r.code, 0, `渲染应成功，实际输出：\n${r.out}`);
  const site = effective(r.siteText || '');
  assert.match(site, /listen 80;/, '正式模板仍监听 80');
  assert.match(site, /listen 443 ssl/, '正式模板仍监听 443（http2 兼容脚本会把 `http2 on;` 降级成 `listen 443 ssl http2;`）');
  assert.ok(!/http2 on;/.test(site), '兼容脚本必须把 http2 on; 降级掉（nginx 1.24 不认）');
});

test('COOKIE_SECURE：默认不写进环境文件（= 跟随 NODE_ENV），显式给 false 才写', () => {
  const r = runInstall('write_env_file');
  assert.equal(r.code, 0, `写环境文件应成功，实际输出：\n${r.out}`);
  const envText = r.envText || '';
  assert.ok(!/^COOKIE_SECURE=/m.test(envText), `默认**不得**写 COOKIE_SECURE（否则空值会静默关掉 Secure）：\n${envText}`);
  assert.match(envText, /^NODE_ENV=production$/m, '默认仍是 production');
});

test('COOKIE_SECURE：显式 false 时写进环境文件', () => {
  const r = runInstall('write_env_file', { HKS_COOKIE_SECURE: 'false' });
  assert.equal(r.code, 0, `写环境文件应成功，实际输出：\n${r.out}`);
  const envText = r.envText || '';
  assert.match(envText, /^COOKIE_SECURE=false$/m, '显式 false 必须写进环境文件');
  assert.match(envText, /^NODE_ENV=production$/m, '⛔ 不得用 NODE_ENV=development 去绕（那会改掉其它生产行为）');
});

test('COOKIE_SECURE：非法值必须 fail-fast 报人话（不得静默当没设）', () => {
  const r = runInstall('validate_cookie_secure', { HKS_COOKIE_SECURE: 'abc' });
  assert.notEqual(r.code, 0, '非法值必须非 0 退出');
  assert.match(r.out, /COOKIE_SECURE/, '报错要说清是 COOKIE_SECURE');
  assert.match(r.out, /true 或 false/, '报错要说清只能给 true 或 false');
});

test('NGINX_HTTP_PORT：非法值必须 fail-fast 报人话', () => {
  for (const bad of ['abc', '0', '70000']) {
    const r = runInstall('validate_http_port', { HKS_HTTP_PORT: bad });
    assert.notEqual(r.code, 0, `端口 ${bad} 必须非 0 退出`);
    assert.match(r.out, /NGINX_HTTP_PORT/, `报错要说清是 NGINX_HTTP_PORT（实际 ${bad}）`);
  }
});

test('模板占位符与 install.sh 的替换一一对应（不许漏替换）', () => {
  const sh = read('install.sh');
  for (const ph of ['__SERVER_NAME__', '__CERT_PATH__', '__KEY_PATH__', '__APP_DIR__', '__HTTP_PORT__']) {
    assert.ok(sh.includes(ph), `install.sh 必须处理占位符 ${ph}`);
  }
  // 两个模板里的占位符都必须在 install.sh 里有对应的替换
  for (const tpl of ['nginx.conf', 'nginx-plain-http.conf']) {
    const body = read(tpl);
    for (const m of body.matchAll(/__[A-Z_]+__/g)) {
      assert.ok(sh.includes(m[0]), `install.sh 必须能替换 ${tpl} 里的占位符 ${m[0]}`);
    }
  }
});

// ── 应用侧：COOKIE_SECURE 的实际语义 ─────────────────────────────────────
function makeApp() {
  const dataDir = mkdtempSync(join(tmpdir(), 'heikesong-cookie-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, join(here, '..', 'db', 'migrations'));
  const { rules } = loadRules(join(here, '..', 'rules'));
  const user = createUser(db, { name: '甲', phone: '13900000009', password: 'pw', mbaStatus: 'mba' });
  const webDir = join(dataDir, 'web');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<h1>home</h1>');
  const app = createApp({ db, rules, webDir });
  return { db, close, dataDir, app, user };
}

async function loginAndGetCookie(app, phone) {
  const res = await call(app, 'POST', '/api/auth/login', {
    body: { phone, password: 'pw' },
  });
  return res;
}

test('COOKIE_SECURE：默认跟随 NODE_ENV（不设时行为与以前完全一致）', async () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedCookie = process.env.COOKIE_SECURE;
  try {
    // 不设 COOKIE_SECURE + NODE_ENV=production ⇒ Secure
    delete process.env.COOKIE_SECURE;
    process.env.NODE_ENV = 'production';
    const a = makeApp();
    try {
      const res = await loginAndGetCookie(a.app, a.user.phone);
      assert.equal(res.status, 200, `登录应成功，实际 ${res.status} ${res.body}`);
      assert.match(res.headers['Set-Cookie'], /Secure/, 'production 下必须有 Secure');
    } finally { a.close(); }

    // 不设 COOKIE_SECURE + NODE_ENV 非 production ⇒ 无 Secure
    delete process.env.COOKIE_SECURE;
    process.env.NODE_ENV = 'development';
    const b = makeApp();
    try {
      const res = await loginAndGetCookie(b.app, b.user.phone);
      assert.equal(res.status, 200, `登录应成功，实际 ${res.status} ${res.body}`);
      assert.ok(!/Secure/.test(res.headers['Set-Cookie']), '非 production 下不该有 Secure');
    } finally { b.close(); }
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedCookie === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = savedCookie;
  }
});

test('COOKIE_SECURE：显式 false 能让 production 下也不带 Secure（让路形态需要）', async () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedCookie = process.env.COOKIE_SECURE;
  try {
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_SECURE = 'false';
    const a = makeApp();
    try {
      const res = await loginAndGetCookie(a.app, a.user.phone);
      assert.equal(res.status, 200, `登录应成功，实际 ${res.status} ${res.body}`);
      assert.ok(!/Secure/.test(res.headers['Set-Cookie']), '显式 false ⇒ 不带 Secure');
      assert.match(res.headers['Set-Cookie'], /HttpOnly/, '⛔ HttpOnly 不能被一起关掉');
      assert.match(res.headers['Set-Cookie'], /SameSite=Lax/, '⛔ SameSite 不能被一起关掉');
    } finally { a.close(); }
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedCookie === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = savedCookie;
  }
});

test('COOKIE_SECURE：显式 true 时即便非 production 也带 Secure', async () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedCookie = process.env.COOKIE_SECURE;
  try {
    process.env.NODE_ENV = 'development';
    process.env.COOKIE_SECURE = 'true';
    const a = makeApp();
    try {
      const res = await loginAndGetCookie(a.app, a.user.phone);
      assert.equal(res.status, 200, `登录应成功，实际 ${res.status} ${res.body}`);
      assert.match(res.headers['Set-Cookie'], /Secure/, '显式 true ⇒ 必须带 Secure');
    } finally { a.close(); }
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedCookie === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = savedCookie;
  }
});

test('COOKIE_SECURE：非法值按「要 Secure」处理（失败即安全，不得静默关掉保护）', async () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedCookie = process.env.COOKIE_SECURE;
  try {
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_SECURE = 'flase';   // 拼错
    const a = makeApp();
    try {
      const res = await loginAndGetCookie(a.app, a.user.phone);
      assert.equal(res.status, 200, `登录应成功，实际 ${res.status} ${res.body}`);
      assert.match(res.headers['Set-Cookie'], /Secure/, '非法值不得被当成「关掉 Secure」');
    } finally { a.close(); }
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedCookie === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = savedCookie;
  }
});

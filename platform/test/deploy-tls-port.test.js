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

/** 去掉整行注释，只留真正参与配置语义的行（与 deploy-plain-http.test.js 同款口径）。 */
function effective(text) {
  return String(text).split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
}

/** 取出配置里的 upstream 名字（判「会不会撞名」用）。 */
function upstreamNames(text) {
  return [...effective(text).matchAll(/^\s*upstream\s+([A-Za-z0-9_]+)\s*\{/gm)].map((m) => m[1]);
}

// ── 沙箱：在临时目录里 source install.sh 并调用指定函数 ──────────────────
function runInstall(body, env = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'heikesong-tls-'));
  try {
    // 去掉末尾的 `main "$@"`（否则它会去改机器状态）
    writeFileSync(join(tmp, 'install.sh'), read('install.sh').replace(/^main "\$@"$/m, ''));

    const binDir = join(tmp, 'bin');
    mkdirSync(binDir, { recursive: true });
    // nginx 桩：`-v` 打印版本（compat 脚本要探测），`-t` 一律通过
    const version = env.HKS_NGINX_VERSION || '1.24.0';
    writeFileSync(
      join(binDir, 'nginx'),
      `#!/bin/sh\nif [ "$1" = "-v" ]; then echo "nginx version: nginx/${version} (Ubuntu)" >&2; exit 0; fi\nexit 0\n`,
    );
    chmodSync(join(binDir, 'nginx'), 0o755);
    // systemctl 桩：reload / restart 都成功（否则写站点那步会以非 0 退出）
    writeFileSync(join(binDir, 'systemctl'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binDir, 'systemctl'), 0o755);
    // ps 桩（只在校验「reload 有没有真生效」那两条用例里需要）：
    //   HKS_PS_MODE=constant ⇒ 每次都打印同一组 worker（模拟「reload 没生效」）
    //   HKS_PS_MODE=changing ⇒ 第一次一组、之后换一组（模拟「reload 真生效了」）
    if (env.HKS_PS_MODE) {
      const counter = join(tmp, 'ps-counter');
      writeFileSync(
        join(binDir, 'ps'),
        `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > "${counter}"\n`
        + (env.HKS_PS_MODE === 'changing'
          ? 'if [ "$n" -le 1 ]; then echo "111 222"; else echo "111 333"; fi\n'
          : 'echo "111 222"\n'),
      );
      chmodSync(join(binDir, 'ps'), 0o755);
    }

    const script = [
      'set -uo pipefail',
      `export PATH="${binDir}:$PATH"`,
      `export NGINX_SITE="${tmp}/etc/nginx/sites-available/heikesong.conf"`,
      `export NGINX_LINK="${tmp}/etc/nginx/sites-enabled/heikesong.conf"`,
      'export SERVER_NAME="8.133.200.235"',
      `export APP_DIR="${tmp}/app"`,
      `export DATA_DIR="${tmp}/data"`,
      `export ENV_FILE="${tmp}/platform.env"`,
      // ⚠️ 必须**隔离** NGINX_PID_FILE：否则这台机器上真的跑着 nginx 时，
      //    沙箱会读到**真机器**的 pid 文件 → 触发 reload 生效校验 → 用例结果依赖宿主机状态。
      `export NGINX_PID_FILE="${tmp}/nginx.pid"`,
      // 需要校验 reload 生效时，让 pid 文件指向**活着的**进程（沙箱 bash 自己）
      ...(env.HKS_PS_MODE ? [`printf '%s' "$$" > "\${NGINX_PID_FILE}"`] : []),
      'mkdir -p "$(dirname "$NGINX_SITE")" "$(dirname "$NGINX_LINK")"',
      `source "${tmp}/install.sh"`,
      // source 之后 SCRIPT_DIR/ROOT 是按 $0 算的（source 时 $0 是 bash）⇒ 必须改回来
      `SCRIPT_DIR="${deployDir}"`,
      `ROOT="${join(here, '..')}"`,
      `NGINX_COMPAT_SCRIPT="${deployDir}/nginx-http2-compat.sh"`,
      // ⚠️ 覆盖必须在 source **之后**做：install.sh 在被 source 时就把
      //    NGINX_TEMPLATE / NGINX_HTTP_PORT / NGINX_TLS_PORT / COOKIE_SECURE
      //    固化成了自己的值。用 HKS_* 前缀，避免和 install.sh 自己的变量名撞车。
      `NGINX_TEMPLATE="${env.HKS_TEMPLATE || join(deployDir, 'nginx-tls-port.conf')}"`,
      // ⚠️ 「不设 NGINX_TLS_PORT」要测的是 install.sh 自己的默认值（443），
      //    所以这里**不能**用 `env.HKS_TLS_PORT || '8444'` ——
      //    JS 里空串是假值，会被悄悄换成 8444，测的就不是「默认」了。
      //    HKS_TLS_PORT_UNSET=1 ⇒ 整行覆盖都不写 ⇒ 保留 source 时的值。
      ...(env.HKS_TLS_PORT_UNSET ? [] : [`NGINX_TLS_PORT="${env.HKS_TLS_PORT ?? '8444'}"`]),
      ...(env.HKS_HTTP_PORT_UNSET ? [] : [`NGINX_HTTP_PORT="${env.HKS_HTTP_PORT ?? '8081'}"`]),
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

// ── 模板本身的硬约束 ──────────────────────────────────────────────────

test('TLS 端口模板存在：deploy/nginx-tls-port.conf', () => {
  assert.ok(existsSync(join(deployDir, 'nginx-tls-port.conf')), 'TLS 端口模板必须存在');
});

test('TLS 端口模板：监听占位符端口 + 挂证书 + 只允许 TLSv1.2/1.3', () => {
  const conf = effective(read('nginx-tls-port.conf'));
  assert.match(conf, /listen __TLS_PORT__ ssl;/, '必须用 __TLS_PORT__ 占位（端口由 install.sh 注入）');
  assert.match(conf, /listen \[::\]:__TLS_PORT__ ssl;/, 'IPv6 那一支也要挂上');
  assert.match(conf, /ssl_certificate\s+__CERT_PATH__;/, '必须引用证书占位符');
  assert.match(conf, /ssl_certificate_key\s+__KEY_PATH__;/, '必须引用私钥占位符');
  assert.match(conf, /ssl_protocols\s+TLSv1\.2 TLSv1\.3;/, '必须禁掉 TLSv1/1.1');
  assert.ok(!/__HTTP_PORT__/.test(conf), '⛔ TLS 口不得复用明文端口占位符（两个开关语义必须分开）');
});

test('TLS 端口模板：⛔ 不含 80 端口的 server 块（抢 default_server 会毁掉既有业务 + 掐断 ACME 续期）', () => {
  const conf = effective(read('nginx-tls-port.conf'));
  assert.ok(!/listen\s+80\b/.test(conf), '⛔ 不得监听 80（80 是既有业务的 default_server）');
  assert.ok(!/listen\s+\[::\]:80\b/.test(conf), '⛔ 不得监听 [::]:80');
  assert.ok(!/return 301/.test(conf), '⛔ 没有 80 入口可跳，不得出现 301 跳转');
  assert.ok(!/acme-challenge/.test(conf), '⛔ ACME 校验目录归既有 default_server 管，本模板不碰');
});

test('TLS 端口模板：upstream 名与另两个模板都不同（同名会让 nginx -t 报 duplicate upstream 并带崩全站）', () => {
  const names = upstreamNames(read('nginx-tls-port.conf'));
  assert.deepEqual(names, ['heikesong_app_tls'], `本模板的 upstream 名应是 heikesong_app_tls，实际 ${JSON.stringify(names)}`);
  for (const other of ['nginx.conf', 'nginx-plain-http.conf']) {
    const otherNames = upstreamNames(read(other));
    for (const n of names) {
      assert.ok(!otherNames.includes(n), `⛔ upstream 名 "${n}" 与 ${other} 撞名（nginx 会报 duplicate upstream）`);
    }
  }
});

test('TLS 端口模板：上游口径 127.0.0.1:8080，SSE 关缓冲、真实 IP 与 X-Forwarded-Proto 都要透传', () => {
  const conf = effective(read('nginx-tls-port.conf'));
  assert.match(conf, /server 127\.0\.0\.1:8080;/, '上游必须是 127.0.0.1:8080（与应用端口口径同一套）');
  assert.match(conf, /proxy_buffering off;/, 'SSE 必须关缓冲');
  assert.match(conf, /add_header X-Accel-Buffering no;/, 'SSE 必须发 X-Accel-Buffering: no');
  assert.match(conf, /proxy_set_header X-Real-IP \$remote_addr;/, '必须透传真实客户端 IP（审计要读）');
  assert.match(conf, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/, '必须透传 X-Forwarded-For');
  assert.match(conf, /proxy_set_header X-Forwarded-Proto \$scheme;/, '必须透传 X-Forwarded-Proto（https 下应用要读它）');
  // upstream 名字要出现在 proxy_pass 里（模板内自洽：改了 upstream 名忘了改 proxy_pass 会 502）
  assert.match(conf, /proxy_pass http:\/\/heikesong_app_tls;/, 'proxy_pass 必须指向本模板自己的 upstream');
});

// ── install.sh 的开关 ─────────────────────────────────────────────────

test('install.sh：NGINX_TLS_PORT 开关齐备（默认值 / 校验 / 占位符替换）', () => {
  const sh = read('install.sh');
  assert.match(sh, /NGINX_TLS_PORT="\$\{NGINX_TLS_PORT:-443\}"/, '默认 TLS 端口 443（不给变量时行为不变）');
  assert.match(sh, /__TLS_PORT__/, 'install.sh 必须替换 __TLS_PORT__ 占位符');
  assert.match(sh, /validate_tls_port\(\)/, '必须有独立校验函数');
  assert.match(sh, /validate_tls_port\s*$/m, 'main 里必须调用校验（fail-fast：动任何东西之前）');
});

test('install.sh：端口校验逻辑只有一份（两个开关共用 check_port，不许复制粘贴漂移）', () => {
  const sh = effective(read('install.sh'));
  assert.match(sh, /check_port\(\)\s*\{/, '必须有公共端口校验函数');
  assert.match(sh, /validate_http_port\(\)\s*\{\s*check_port "NGINX_HTTP_PORT"/, '明文口走公共校验');
  assert.match(sh, /validate_tls_port\(\)\s*\{\s*check_port "NGINX_TLS_PORT"/, 'TLS 口走公共校验');
  // ⛔ 若有人把校验复制成两份，这里会数到两个 65535 判断 ⇒ 漂移的温床
  const rangeChecks = sh.match(/必须是 1-65535 的整数/g) || [];
  assert.equal(rangeChecks.length, 1, `端口区间判断必须只有一份，实际 ${rangeChecks.length} 份`);
});

// ── 沙箱实跑：渲染出来的站点必须正确 ──────────────────────────────────

test('沙箱实跑：TLS 端口渲染 = 8444 + 占位符零残留 + 不含 80 块', () => {
  const r = runInstall('write_nginx_site');
  assert.equal(r.code, 0, `渲染应成功，实际输出：\n${r.out}`);
  const site = effective(r.siteText || '');
  assert.match(site, /listen 8444 ssl/, `必须监听 8444 ssl，实际：\n${site.slice(0, 400)}`);
  assert.match(site, /listen \[::\]:8444 ssl( http2)?;/, 'IPv6 那一支也要是 8444');
  assert.ok(!/__[A-Z_]+__/.test(site), `占位符必须零残留，实际：\n${site}`);
  assert.match(site, /server_name 8\.133\.200\.235;/, 'server_name 应替换成传入的 SERVER_NAME');
  assert.match(site, /ssl_certificate\s+\/etc\/letsencrypt\/live\/8\.133\.200\.235\/fullchain\.pem;/, '证书路径应由 SERVER_NAME 推导');
  assert.ok(!/listen\s+80\b/.test(site), '⛔ 渲染结果不得出现 80 监听');
});

test('沙箱实跑：nginx 1.24（老版本）下 http2 正确降级到 listen 8444 ssl http2;', () => {
  const r = runInstall('write_nginx_site', { HKS_NGINX_VERSION: '1.24.0' });
  assert.equal(r.code, 0, `渲染应成功，实际输出：\n${r.out}`);
  const site = effective(r.siteText || '');
  assert.match(site, /listen 8444 ssl http2;/, '⛔ 老版本必须降级成 `listen <端口> ssl http2;`（否则 HTTP/2 被静默丢弃）');
  assert.ok(!/http2 on;/.test(site), '⛔ 老版本不得残留独立的 `http2 on;`（该 nginx 版本不认这个指令）');
});

test('沙箱实跑：nginx 1.25.1（新版本）下保留 http2 on; 写法', () => {
  const r = runInstall('write_nginx_site', { HKS_NGINX_VERSION: '1.25.1' });
  assert.equal(r.code, 0, `渲染应成功，实际输出：\n${r.out}`);
  const site = effective(r.siteText || '');
  assert.match(site, /^\s*http2 on;$/m, '新版本必须保留 `http2 on;`');
  assert.match(site, /listen 8444 ssl;/, '新版本 listen 行不应被降级脚本改写');
});

test('沙箱实跑：不设 NGINX_TLS_PORT 时默认渲染 443（默认行为不变）', () => {
  const r = runInstall('write_nginx_site', { HKS_TLS_PORT_UNSET: '1' });
  assert.equal(r.code, 0, `渲染应成功，实际输出：\n${r.out}`);
  const site = effective(r.siteText || '');
  assert.match(site, /listen 443 ssl/, `默认必须是 443，实际：\n${site.slice(0, 300)}`);
});

test('沙箱实跑：TLS 模板与让路模板的 upstream 名不同（两份站点并存不会撞名）', () => {
  const tls = runInstall('write_nginx_site', { HKS_TEMPLATE: join(deployDir, 'nginx-tls-port.conf') });
  const plain = runInstall('write_nginx_site', { HKS_TEMPLATE: join(deployDir, 'nginx-plain-http.conf') });
  assert.equal(tls.code, 0, `TLS 渲染应成功，实际输出：\n${tls.out}`);
  assert.equal(plain.code, 0, `让路渲染应成功，实际输出：\n${plain.out}`);
  const tlsNames = upstreamNames(tls.siteText || '');
  const plainNames = upstreamNames(plain.siteText || '');
  assert.equal(tlsNames.length, 1, 'TLS 站点应只有一个 upstream');
  assert.equal(plainNames.length, 1, '让路站点应只有一个 upstream');
  assert.notDeepEqual(tlsNames, plainNames, `⛔ 两份站点同时启用时 upstream 撞名（nginx 报 duplicate upstream，整个 nginx 起不来）：${tlsNames} vs ${plainNames}`);
});

test('NGINX_TLS_PORT：非法值必须 fail-fast 报人话', () => {
  for (const bad of ['abc', '0', '70000', '']) {
    const r = runInstall('validate_tls_port', { HKS_TLS_PORT: bad });
    assert.notEqual(r.code, 0, `端口 ${bad || '(空)'} 必须非 0 退出`);
    assert.match(r.out, /NGINX_TLS_PORT/, `报错要说清是 NGINX_TLS_PORT（实际 ${bad || '(空)'}）`);
  }
});

test('模板占位符与 install.sh 的替换一一对应（不许漏替换）', () => {
  const sh = read('install.sh');
  for (const tpl of ['nginx.conf', 'nginx-plain-http.conf', 'nginx-tls-port.conf', 'nginx-https-redirect.conf']) {
    const body = read(tpl);
    for (const m of body.matchAll(/__[A-Z_]+__/g)) {
      assert.ok(sh.includes(m[0]), `install.sh 必须能替换 ${tpl} 里的占位符 ${m[0]}`);
    }
  }
});

// ── 明文入口的 308 跳转模板 ────────────────────────────────────────────

test('跳转模板存在：deploy/nginx-https-redirect.conf', () => {
  assert.ok(existsSync(join(deployDir, 'nginx-https-redirect.conf')), '跳转模板必须存在');
});

test('跳转模板：只做 308 跳转、目标**显式带 TLS 端口**，且⛔不代理业务（无 upstream）', () => {
  const conf = effective(read('nginx-https-redirect.conf'));
  assert.match(conf, /return 308 https:\/\/\$host:__TLS_PORT__\$request_uri;/, '跳转目标必须带 TLS 端口（$host 不含端口，不带就跳到 443 去）');
  assert.match(conf, /listen __HTTP_PORT__;/, '明文口用 __HTTP_PORT__ 占位');
  assert.deepEqual(upstreamNames(read('nginx-https-redirect.conf')), [], '⛔ 跳转模板不得定义 upstream（不代理业务）');
  assert.ok(!/\bssl\b/.test(conf), '跳转模板本身是明文口，不该出现 ssl');
});

test('沙箱实跑：跳转模板渲染 = 明文口 + 308 到 TLS 端口 + 占位符零残留', () => {
  const r = runInstall('write_nginx_site', { HKS_TEMPLATE: join(deployDir, 'nginx-https-redirect.conf') });
  assert.equal(r.code, 0, `渲染应成功，实际输出：\n${r.out}`);
  const site = effective(r.siteText || '');
  assert.match(site, /listen 8081;/, `必须监听 8081，实际：\n${site}`);
  assert.match(site, /return 308 https:\/\/\$host:8444\$request_uri;/, '⛔ 跳转目标必须带上 TLS 端口 8444');
  assert.ok(!/__[A-Z_]+__/.test(site), `占位符必须零残留，实际：\n${site}`);
});

test('沙箱实跑：跳转模板与 TLS 模板可并存（端口不同、upstream 不撞名）', () => {
  const redirect = runInstall('write_nginx_site', { HKS_TEMPLATE: join(deployDir, 'nginx-https-redirect.conf') });
  const tls = runInstall('write_nginx_site', { HKS_TEMPLATE: join(deployDir, 'nginx-tls-port.conf') });
  assert.equal(redirect.code, 0, `跳转渲染应成功，实际输出：\n${redirect.out}`);
  assert.equal(tls.code, 0, `TLS 渲染应成功，实际输出：\n${tls.out}`);
  const redirectSite = effective(redirect.siteText || '');
  const tlsSite = effective(tls.siteText || '');
  assert.match(redirectSite, /listen 8081;/, '跳转口 8081');
  assert.match(tlsSite, /listen 8444 ssl/, 'TLS 口 8444');
  assert.deepEqual(upstreamNames(redirect.siteText || ''), [], '跳转模板无 upstream');
  assert.deepEqual(upstreamNames(tls.siteText || ''), ['heikesong_app_tls'], 'TLS 模板只有一个 upstream');
});

test('沙箱实跑：明文口与 TLS 口都可用自定义端口（不写死 8081/8444）', () => {
  const r = runInstall('write_nginx_site', {
    HKS_TEMPLATE: join(deployDir, 'nginx-https-redirect.conf'),
    HKS_HTTP_PORT: '8083',
    HKS_TLS_PORT: '9443',
  });
  assert.equal(r.code, 0, `渲染应成功，实际输出：\n${r.out}`);
  const site = effective(r.siteText || '');
  assert.match(site, /listen 8083;/, '明文口应被替换成 8083');
  assert.match(site, /return 308 https:\/\/\$host:9443\$request_uri;/, '跳转目标的 TLS 端口应被替换成 9443');
});

// ── nginx reload 的「生效校验」护栏 ───────────────────────────────────

test('⛔ reload 没生效（worker 集合不变）⇒ install.sh 必须失败并说清原因，不许报成功', () => {
  const r = runInstall('write_nginx_site', { HKS_PS_MODE: 'constant' });
  assert.notEqual(r.code, 0, '⛔ reload 没生效却退出 0 = 静默失败（线上跑旧配置，运维以为部署成功）');
  assert.match(r.out, /没有生效/, '报错要说清是「reload 没生效」');
  assert.match(r.out, /旧配置/, '报错要点明「线上仍在跑旧配置」');
});

test('reload 生效（worker 换代）⇒ install.sh 必须正常成功', () => {
  const r = runInstall('write_nginx_site', { HKS_PS_MODE: 'changing' });
  assert.equal(r.code, 0, `reload 生效时必须成功，实际输出：\n${r.out}`);
  assert.ok(!/没有生效/.test(r.out), '不该报「没有生效」');
});

test('读不到 pid 文件时校验必须**放行**（不能误伤首次部署 / 非 Linux 平台）', () => {
  // 不设 HKS_PS_MODE ⇒ 沙箱不建 pid 文件 ⇒ master 读不到 ⇒ 校验应跳过并成功
  const r = runInstall('write_nginx_site');
  assert.equal(r.code, 0, `应当跳过校验并成功，实际输出：\n${r.out}`);
  assert.match(r.out, /跳过 nginx reload 生效校验/, '应当明确告知「跳过校验」');
});

// ── 浏览器重定向语义：POST 的方法与请求体会不会被吃掉 ──────────────────

/**
 * 浏览器（与 curl）处理重定向的规则：
 *   301 / 302 / 303 ⇒ **把 POST 降级成 GET，并丢掉请求体**；
 *   307 / 308       ⇒ **保留方法与请求体**，原样重发。
 * 写成函数而不是写死 308，是为了让「这条规则」本身成为可执行断言 ——
 * 只断言「字符串里有 308」的话，把 308 改成 302 也能骗过「匹配 /return 3\d\d/」这类弱断言。
 */
function redirectPreservesPostBody(status) {
  return status === 307 || status === 308;
}

test('⛔ 明文入口的重定向必须保留 POST 方法与请求体（否则登录会被误报成「手机号或密码不正确」）', () => {
  const r = runInstall('write_nginx_site', { HKS_TEMPLATE: join(deployDir, 'nginx-https-redirect.conf') });
  assert.equal(r.code, 0, `渲染应成功，实际输出：\n${r.out}`);
  const site = effective(r.siteText || '');
  const m = site.match(/return (\d{3}) https:\/\/\$host:(\d+)\$request_uri;/);
  assert.ok(m, `渲染结果里应有 "return <状态码> https://$host:<端口>$request_uri;"，实际：\n${site}`);
  const status = Number(m[1]);
  assert.ok(
    redirectPreservesPostBody(status),
    `⛔ 状态码 ${status} 会让浏览器把 POST 降级成 GET 并丢掉请求体 ⇒ 登录接口收到空 body ⇒ `
    + `返回 401「手机号或密码不正确」⇒ **用户会以为口令错了，真相是重定向把请求体吃了** ⇒ 必须用 307/308`,
  );
});

test('⛔ 回归钉子：301 确实会丢 POST 请求体（这条用例本身要能判别「规则写反了」）', () => {
  // 对照组：把规则反过来用，断言必须失败 —— 证明上面的判定函数不是「永远为真」
  assert.equal(redirectPreservesPostBody(301), false, '301 不得被判定为保留请求体');
  assert.equal(redirectPreservesPostBody(303), false, '303 不得被判定为保留请求体');
  assert.equal(redirectPreservesPostBody(307), true, '307 必须保留请求体');
  assert.equal(redirectPreservesPostBody(308), true, '308 必须保留请求体');
});

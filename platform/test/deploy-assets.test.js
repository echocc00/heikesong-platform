import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { isolateTempDir } from '../test-helpers/tmp.js';

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

/**
 * 去掉整行注释，只留**真正参与配置语义**的行。
 * systemd 的 '#' 与 YAML 的 '#' 都从行首起，shell 的 '#' 同理。
 * 为什么要这一步：注释里写「默认值 /opt/heikesong/platform」是**文档**，
 * 不是「把部署路径写死在配置里」；两件事必须分开断言，
 * 否则断言会把有用的注释也一起禁掉（→ 假红 / 假绿）。
 */
function effective(text) {
  return String(text).split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
}

// ── 真实代码里的口径（部署资产必须与它一致，不能各写各的）────────────────
const serverSrc = readSrc(join('server.js'));
const sessionSrc = readSrc(join('auth', 'session.js'));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

/** 应用真实默认端口：src/server.js 的 `process.env.PORT || <数字>` */
const APP_PORT = (serverSrc.match(/process\.env\.PORT\s*\|\|\s*(\d+)/) || [])[1];
/** 应用真实的数据目录环境变量名 */
const APP_DATA_DIR_VAR = (serverSrc.match(/process\.env\.([A-Z_]*DATA_DIR)/) || [])[1];
/** 应用真实的会话有效期环境变量名 */
const APP_SESSION_TTL_VAR = (sessionSrc.match(/process\.env\.([A-Z_]*SESSION_TTL_DAYS)/) || [])[1];
/** 应用真实的健康检查路径 */
const APP_HEALTH_PATH = (serverSrc.match(/router\.add\('GET',\s*'([^']+)'/) || [])[1];
/** package.json engines.node 的主版本与次版本（部署脚本的下限必须与它一致） */
const ENGINE = (pkg.engines.node || '').match(/(\d+)\.(\d+)/) || [];
const APP_ENGINE_MAJOR = Number(ENGINE[1]);
const APP_ENGINE_MINOR = Number(ENGINE[2]);

test('systemd 单元：常驻守护 + 工作目录 + 环境文件 + journald 日志 + 非 root 运行', () => {
  const unit = read('heikesong.service');
  assert.match(unit, /^Restart=always$/m, '必须崩溃后自动拉起');
  assert.match(unit, /^WorkingDirectory=/m, '必须写明工作目录');
  assert.match(unit, /^EnvironmentFile=/m, '必须用环境文件承载配置');
  assert.match(unit, /^User=\w+/m, '必须指定运行用户');
  assert.match(unit, /^Group=\w+/m, '必须指定运行组');
  assert.match(unit, /^StandardOutput=journal$/m, '日志必须走 journald');
  assert.match(unit, /^StandardError=journal$/m, '日志必须走 journald');
  assert.doesNotMatch(unit, /^User=root$/m, '⛔ 禁止以 root 运行');
  assert.match(unit, /__APP_DIR__/, '必须用占位符，不硬编码部署路径');
});

test('systemd 单元：⛔ 不得出现多 worker / cluster', () => {
  const unit = read('heikesong.service');
  assert.doesNotMatch(unit, /--workers/, '⛔ 禁止多 worker 进程写同一个 SQLite 文件');
  assert.doesNotMatch(unit, /\bcluster\b/, '⛔ 禁止 cluster 模式');
  assert.doesNotMatch(unit, /ExecStart=.*\snode\s+--cluster/, '⛔ 禁止 cluster 模式');
});

test('nginx：反代 + 真实客户端 IP 透传 + SSE 关缓冲，四组指令一字不差', () => {
  const conf = read('nginx.conf');
  assert.match(conf, /proxy_set_header Connection '';/, '必须清掉 Connection 头（配合 HTTP/1.1 keepalive）');
  assert.match(conf, /proxy_http_version 1\.1;/, '必须 HTTP/1.1');
  assert.match(conf, /proxy_set_header X-Real-IP \$remote_addr;/, '审计日志要读真实客户端 IP');
  assert.match(conf, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/, '审计日志要读真实客户端 IP');
  assert.match(conf, /proxy_buffering off;/, 'SSE 必须关闭缓冲');
  assert.match(conf, /proxy_read_timeout 360s;/, 'SSE 长连接超时');
  assert.match(conf, /add_header X-Accel-Buffering no;/, 'SSE 必须关掉 nginx 缓冲');
  assert.match(conf, /__SERVER_NAME__/, '域名必须是占位符');
  assert.match(conf, /__CERT_PATH__/, '证书路径必须是占位符');
  assert.match(conf, /__KEY_PATH__/, '密钥路径必须是占位符');
});

test('nginx：静态资源直出 + 缓存（扩容只能加读）', () => {
  const conf = read('nginx.conf');
  assert.match(conf, /location \/assets\//, '静态资源必须单独 location');
  assert.match(conf, /expires \d+d;/, '静态资源必须有缓存期');
  assert.match(conf, /Cache-Control "no-cache"/, 'index.html 不能被缓存');
});

test('docker-compose：单容器、⛔ 不配 workers/cluster、数据持久化、有健康检查', () => {
  const yml = read('docker-compose.yml');
  assert.doesNotMatch(yml, /--workers/, '⛔ 禁止多 worker 进程写同一个 SQLite 文件');
  assert.doesNotMatch(yml, /^\s*cluster\s*:/m, '⛔ 禁止 cluster 编排');
  assert.match(yml, /restart:\s*always/, '必须自动重启');
  assert.match(yml, /DATA_DIR/, '必须声明数据目录');
  assert.match(yml, /volumes:/, '必须持久化数据');
  assert.match(yml, /healthcheck:/, '必须有健康检查');
});

test('install.sh：set -euo pipefail + 路径不依赖当前工作目录 + 不硬编码口令', () => {
  const sh = read('install.sh');
  assert.match(sh, /^set -euo pipefail$/m, '必须开启严格模式');
  assert.match(sh, /\$\(cd "\$\(dirname "\$0"\)" && pwd\)/, '必须用脚本自身位置定位，不依赖 cwd');
  assert.doesNotMatch(sh, /PASSWORD\s*=\s*["'][^"'$][^"']*["']/, '⛔ 不得出现硬编码口令');
  assert.doesNotMatch(sh, /password\s*=\s*["'][^"'$][^"']*["']/i, '⛔ 不得出现硬编码口令');
  assert.match(sh, /ADMIN_PASSWORD/, '管理员口令必须来自环境变量');
  assert.match(sh, /id -u/, '必须做幂等守卫（用户已存在则跳过）');
  assert.match(sh, /systemctl daemon-reload/, '必须 reload systemd');
  assert.match(sh, /nginx -t/, '必须先 nginx -t 再 reload');
});

test('install.sh：占位符与被替换的资产一一对应', () => {
  const sh = read('install.sh');
  for (const ph of ['__APP_DIR__', '__DATA_DIR__', '__RUN_USER__', '__SERVER_NAME__', '__CERT_PATH__', '__KEY_PATH__']) {
    assert.ok(sh.includes(ph), `install.sh 必须替换占位符 ${ph}`);
  }
});

// ── 以下为预审追加：把「字面扫一遍」升级成「对配置本身断言」──────────────

test('systemd 单元：只起【一个】Node 进程 + 入口是真实入口 + ⛔ 不得设 DEMO_MODE=1', () => {
  const unit = read('heikesong.service');
  const eff = effective(unit);
  const execStarts = eff.match(/^ExecStart=.*$/gm) || [];
  assert.equal(execStarts.length, 1, '⛔ 只能有一条 ExecStart（多进程 = 多写者 = SQLITE_BUSY）');
  assert.match(execStarts[0], /src\/server\.js$/, '入口必须是应用真实入口 src/server.js');
  assert.doesNotMatch(execStarts[0], /--worker|--cluster|-c\s*\d/i, '⛔ ExecStart 不得带多进程参数');
  assert.doesNotMatch(eff, /DEMO_MODE\s*=\s*1/, '⛔ 生产部署绝对不得设 DEMO_MODE=1（会挂出 /src/domain/* 与 /rules/*）');
  assert.doesNotMatch(eff, /\/opt\/heikesong\/platform/, '⛔ 部署路径必须走占位符，不得硬编码');
  assert.match(eff, /^Documentation=file:__APP_DIR__\/README\.md$/m, '文档路径也要走占位符');
});

test('nginx：正式形态（域名 + TLS）+ 上游只绑回环 + 端口与真实默认一致', () => {
  const conf = read('nginx.conf');
  assert.ok(APP_PORT, '读不到 src/server.js 的默认端口，测试本身失效');
  assert.match(conf, /listen 443 ssl;/, '正式形态必须是 443 + TLS（备案域名的硬要求）');
  assert.match(conf, /ssl_certificate\s+__CERT_PATH__;/, '必须挂证书');
  assert.match(conf, /ssl_certificate_key\s+__KEY_PATH__;/, '必须挂私钥');
  const upstream = (conf.match(/server\s+([\d.]+):(\d+);/) || []);
  assert.equal(upstream[1], '127.0.0.1', '⛔ 上游必须只绑回环（Node 不直接暴露到公网）');
  assert.equal(upstream[2], APP_PORT, '上游端口必须与应用真实默认端口一致');
  assert.doesNotMatch(conf, /server\s+0\.0\.0\.0/, '⛔ 上游不得绑 0.0.0.0');
});

test('docker-compose：⛔ 不扩副本 + 只绑回环 + ⛔ 不得设 DEMO_MODE=1 + 容器网络可达', () => {
  const yml = read('docker-compose.yml');
  const eff = effective(yml);
  assert.doesNotMatch(eff, /^\s*replicas\s*:/m, '⛔ 禁止 compose 扩副本（多写者）');
  assert.doesNotMatch(eff, /^\s*scale\b/m, '⛔ 禁止 compose scale');
  assert.doesNotMatch(eff, /^\s*deploy\s*:/m, '⛔ 禁止用 deploy.replicas 扩副本');
  assert.doesNotMatch(eff, /DEMO_MODE\s*:\s*"?1"?/, '⛔ 生产部署绝对不得设 DEMO_MODE=1');
  assert.doesNotMatch(eff, /"0\.0\.0\.0:/, '⛔ 端口发布不得绑 0.0.0.0');
  // src/server.js 只绑 127.0.0.1 ⇒ 容器必须与宿主机共享网络栈，
  // 否则宿主机侧 127.0.0.1:8080 连不上（容器 healthy 但宿主 curl 不通）。
  assert.match(eff, /network_mode:\s*host/, 'Node 只绑回环 ⇒ 容器网络必须用 host，否则宿主机反代连不上');
  const health = (eff.match(/http:\/\/127\.0\.0\.1:\d+(\/[^\s'"]*)/) || [])[1];
  assert.equal(health, APP_HEALTH_PATH, '健康检查路径必须是应用真实健康检查路径');
  // 容器里的 Node 必须满足 package.json 的 engines（node:sqlite.backup() 要 22.16.0）
  const imageMajor = Number((eff.match(/image:\s*node:(\d+)/) || [])[1]);
  assert.ok(imageMajor >= APP_ENGINE_MAJOR, `⛔ 容器镜像的 Node 主版本 ${imageMajor} 低于 engines 要求的 ${APP_ENGINE_MAJOR}`);
  // 代码挂载必须只读（代码不进容器，升级靠替换宿主机目录）
  const codeMounts = eff.match(/-\s*\.\.:\/app:\w+/g) || [];
  assert.equal(codeMounts.length, 1, '⛔ 代码只能挂一次（多挂一份 = 多一份可写副本）');
  assert.ok(codeMounts[0].endsWith(':ro'), '⛔ 代码挂载必须只读（:ro）');
  // 容器加固：根文件系统只读 + 丢掉全部 capability
  assert.match(eff, /read_only:\s*true/, '⛔ 容器根文件系统必须只读');
  assert.match(eff, /cap_drop:\s*\n\s*-\s*ALL/, '⛔ 容器必须丢掉全部 capability');
});

test('install.sh：环境文件不落口令 + 幂等守卫齐备 + 口令只能来自环境变量或交互', () => {
  const sh = read('install.sh');
  const envBlock = effective(sh.slice(sh.indexOf('write_env_file()'), sh.indexOf('as_service_user()')));
  assert.ok(envBlock.length > 0, '找不到 write_env_file 函数');
  assert.doesNotMatch(envBlock, /PASSWORD/i, '⛔ 环境文件里绝不能出现口令（口令只用一次、不落盘）');
  assert.doesNotMatch(envBlock, /ADMIN_PHONE/, '环境文件里不写管理员手机号');
  // 幂等守卫：每一条都对应「重复执行不炸」的一种具体机制
  assert.match(sh, /id -u "\$RUN_USER"/, '用户已存在 ⇒ 跳过（不能重复创建）');
  assert.match(sh, /install -d/, '目录已存在 ⇒ install -d 不报错');
  assert.match(sh, /ln -sfn/, '软链已存在 ⇒ ln -sfn 不报错');
  assert.match(sh, /systemctl enable/, 'systemd enable 可重复执行');
  assert.match(sh, /read -rs/, '没有 ADMIN_PASSWORD 时必须交互读取（不回显）');
  assert.match(sh, /\[ -n "\$password" \] \|\| die/, '⛔ 口令读不到时必须明确报错退出（不能带空口令继续）');
});

test('nginx / install.sh：注释不能掩盖配置错误（必须对**有效配置**断言）', () => {
  const conf = effective(read('nginx.conf'));
  const sh = effective(read('install.sh'));
  // 规格的用例 3/6 是「全文扫一遍」：把真指令注释掉，注释里那份文字仍会被扫到 ⇒ 假绿。
  // 这里对**去掉整行注释后**的配置再断言一遍，堵住这个洞。
  assert.match(conf, /proxy_buffering off;/, '⛔ SSE 必须关缓冲（有效配置里不能被注释掉）');
  assert.match(conf, /add_header X-Accel-Buffering no;/, '⛔ SSE 必须关掉 nginx 缓冲（有效配置里不能被注释掉）');
  assert.match(conf, /proxy_read_timeout 360s;/, '⛔ SSE 长连接超时（有效配置里不能被注释掉）');
  assert.match(conf, /proxy_set_header Connection '';/, '⛔ Connection 头必须清空（有效配置里不能被注释掉）');
  assert.match(conf, /proxy_http_version 1\.1;/, '⛔ 必须 HTTP/1.1（有效配置里不能被注释掉）');
  assert.match(sh, /systemctl daemon-reload/, '⛔ 必须 reload systemd（有效配置里不能被注释掉）');
  assert.match(sh, /nginx -t/, '⛔ 必须先 nginx -t 再 reload（有效配置里不能被注释掉）');
  // 静态资源的两个缓存头必须一致：expires N 天 ≡ max-age N*86400 秒
  const expDays = (conf.match(/expires (\d+)d;/) || [])[1];
  const maxAge = (conf.match(/max-age=(\d+)/) || [])[1];
  assert.ok(expDays && maxAge, '读不到 expires / max-age，测试本身失效');
  assert.equal(Number(maxAge), Number(expDays) * 86400, '⛔ expires 与 Cache-Control max-age 必须一致');
  // 每一处 X-Real-IP 都必须透传 $remote_addr（有一处被置空，审计里就是空 IP）
  const realIpTotal = (conf.match(/proxy_set_header X-Real-IP/g) || []).length;
  const realIpOk = (conf.match(/proxy_set_header X-Real-IP \$remote_addr;/g) || []).length;
  assert.equal(realIpOk, realIpTotal, '⛔ 每一处 X-Real-IP 都必须是 $remote_addr（审计要真实客户端 IP）');
});

test('install.sh：Node 下限 / 环境文件权限 / umask / 占位符映射 / locale 安全展开', () => {
  const sh = read('install.sh');
  // ① Node 版本下限必须与 package.json engines 一致（22.16.0 = sqlite.backup() 引入版本）
  assert.ok(APP_ENGINE_MAJOR, '读不到 package.json engines，测试本身失效');
  assert.match(sh, new RegExp(`MIN_NODE_MAJOR=${APP_ENGINE_MAJOR}\\b`), '⛔ Node 主版本下限必须与 engines 一致');
  assert.match(sh, new RegExp(`MIN_NODE_MINOR=${APP_ENGINE_MINOR}\\b`), '⛔ Node 次版本下限必须与 engines 一致');
  // ② 环境文件必须组可读（systemd 以 root 读，但服务组要能读到；0600 会让环境变量全丢）
  assert.match(sh, /chmod 0640 "\$ENV_FILE"/, '⛔ 环境文件权限必须是 0640（组可读）');
  // ③ umask 必须存取成对（不恢复的话，后面的 nginx 站点文件会被建成 600）
  assert.match(sh, /old_umask="\$\(umask\)"/, '⛔ 写环境文件前必须先存 umask');
  assert.match(effective(sh), /umask "\$old_umask"/, '⛔ 写完必须恢复 umask（否则后面的站点文件权限被带偏）');
  // ④ 占位符 → 变量必须一一对应（不能把 __DATA_DIR__ 替换成程序目录），且**每一处**替换值都必须转义
  const appSites = (sh.match(/s\|__APP_DIR__\|/g) || []).length;
  const appEscaped = (sh.match(/s\|__APP_DIR__\|.*sed_escape "\$APP_DIR"/g) || []).length;
  assert.ok(appSites > 0, '读不到 __APP_DIR__ 的替换点，测试本身失效');
  assert.equal(appEscaped, appSites, '⛔ 每一处 __APP_DIR__ 替换都必须走 sed_escape（路径含 & 或 | 时 sed 会写坏）');
  const dataSites = (sh.match(/s\|__DATA_DIR__\|/g) || []).length;
  const dataEscaped = (sh.match(/s\|__DATA_DIR__\|.*sed_escape "\$DATA_DIR"/g) || []).length;
  assert.ok(dataSites > 0, '读不到 __DATA_DIR__ 的替换点，测试本身失效');
  assert.equal(dataEscaped, dataSites, '⛔ 每一处 __DATA_DIR__ 替换都必须走 sed_escape（且必须是数据目录，不是程序目录）');
  // ⑤ locale 安全：$变量 紧跟非 ASCII 字符时，bash 在 C/C.UTF-8 locale 下会把高位字节
  //    并进变量名 → set -u 下直接 unbound variable 崩掉（必须写成 ${变量}）
  const unsafe = [...sh.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*([^\x00-\x7F])/g)].map((m) => m[0]);
  assert.deepEqual(unsafe, [], `⛔ $变量 紧跟非 ASCII 字符会炸（bash 会把高位字节并进变量名）：${unsafe.join(' ')}`);
  // ⑥ 交互读口令必须被保护（read 失败时不能被 set -e 静默打断）
  assert.match(sh, /read -rs password \|\| true/, '⛔ 交互读口令失败必须被显式处理');
});

test('跨资产口径一致：端口 / 数据目录变量 / 会话变量 / 入口 / 健康检查必须与应用真实代码一致', () => {
  const unit = read('heikesong.service');
  const conf = read('nginx.conf');
  const yml = read('docker-compose.yml');
  const sh = read('install.sh');
  assert.ok(APP_PORT, '读不到 src/server.js 的默认端口，测试本身失效');
  assert.ok(APP_DATA_DIR_VAR, '读不到 src/server.js 的数据目录变量，测试本身失效');
  assert.ok(APP_SESSION_TTL_VAR, '读不到 src/auth/session.js 的会话变量，测试本身失效');
  assert.ok(APP_HEALTH_PATH, '读不到 src/server.js 的健康检查路径，测试本身失效');

  // 端口四处同口径
  assert.match(unit, new RegExp(`^Environment=PORT=${APP_PORT}$`, 'm'), 'systemd 端口必须与真实默认一致');
  assert.match(conf, new RegExp(`server 127\\.0\\.0\\.1:${APP_PORT};`), 'nginx 上游端口必须与真实默认一致');
  assert.match(yml, new RegExp(`PORT:\\s*"${APP_PORT}"`), 'compose 端口必须与真实默认一致');
  assert.match(sh, new RegExp(`printf 'PORT=${APP_PORT}`), 'install.sh 写的环境文件端口必须与真实默认一致');

  // 数据目录变量名四处同口径
  assert.match(unit, new RegExp(`^Environment=${APP_DATA_DIR_VAR}=__DATA_DIR__$`, 'm'), 'systemd 数据目录变量名必须与真实代码一致');
  assert.match(yml, new RegExp(`${APP_DATA_DIR_VAR}:\\s*"/data"`), 'compose 数据目录变量名必须与真实代码一致');
  assert.match(sh, new RegExp(`printf '${APP_DATA_DIR_VAR}=%s`), 'install.sh 写的环境文件数据目录变量名必须与真实代码一致');

  // 会话有效期变量名
  assert.match(sh, new RegExp(`${APP_SESSION_TTL_VAR}=`), '环境文件必须写会话有效期变量');

  // 入口与健康检查路径
  assert.match(unit, /src\/server\.js/, 'systemd 入口必须与应用真实入口一致');
  assert.match(yml, new RegExp(APP_HEALTH_PATH.replace(/\//g, '\\/')), 'compose 健康检查路径必须与应用真实健康检查路径一致');
});

// ── P6 部署资产修复轮（父代理）：F-1~F-4 的回归用例 ──────────────────────
// 这四条缺口都不是「样式问题」，每一条都能让一次真实的云主机部署**装到一半**：
//   F-1 前端产物目录三处口径不一致（计划 web/dist/ vs nginx web/assets/ vs install.sh 排除项）
//   F-2 nginx 是最后一步且不检查装没装 ⇒ 前面全都装完了才炸，还留一份坏配置在 sites-enabled
//   F-3 systemd/环境文件漏 SESSION_ABSOLUTE_TTL_DAYS ⇒ 实际生效值与配置对不上
//   F-4 nginx ≥ 1.25.1 才有 `http2 on;`，而 Ubuntu 22.04=1.18 / 24.04=1.24 都没有
//
// ⚠️ 本组用例的断言必须**判别**：把修复改回去（挪顺序 / 删回滚 / 改回降级）必须变红。

test('install.sh：⛔ nginx 必须【在动任何东西之前】检查（否则装到一半才炸）', () => {
  const sh = read('install.sh');
  assert.match(sh, /command -v nginx/, '必须探测 nginx 是否安装');
  assert.match(sh, /require_nginx\(\)\s*\{/, '必须有独立的 nginx 前置检查函数');
  // 顺序断言：main() 里 require_nginx 必须排在所有「会改变机器状态」的调用之前。
  // ⚠️ 这条是判别性的：把 require_nginx 挪到 copy_app 之后 → 立刻变红。
  const mainIdx = sh.indexOf('\nmain() {');
  assert.ok(mainIdx > 0, '找不到 main()，测试本身失效');
  const mainBody = sh.slice(mainIdx);
  const requireIdx = mainBody.indexOf('require_nginx');
  assert.ok(requireIdx > 0, 'main() 里必须调用 require_nginx');
  for (const mutating of [
    'create_service_user', 'prepare_dirs', 'copy_app', 'write_env_file',
    'init_database', 'write_systemd_unit', 'start_service', 'write_nginx_site',
  ]) {
    const idx = mainBody.indexOf(mutating);
    assert.ok(idx > 0, `找不到 ${mutating} 调用，测试本身失效`);
    assert.ok(requireIdx < idx, `⛔ require_nginx 必须排在 ${mutating} 之前（先查前置条件，再动手）`);
  }
});

test('install.sh：nginx -t 失败必须回滚（坏配置绝不能留在 sites-enabled）', () => {
  const sh = read('install.sh');
  // 裸 `nginx -t` + set -e ⇒ 失败即退出，**来不及回滚** ⇒ 必须放在 if 保护下
  assert.match(sh, /if ! nginx -t; then/, 'nginx -t 必须在 if 保护下，失败分支才能做回滚');
  assert.match(sh, /cp -p "\$NGINX_SITE" "\$backup"/, '写新配置前必须先备份旧配置（否则回滚无源可回）');
  const guardIdx = sh.indexOf('if ! nginx -t; then');
  assert.ok(guardIdx > 0, '找不到 nginx -t 保护块，测试本身失效');
  const guardEnd = sh.indexOf('\n  fi', guardIdx);
  assert.ok(guardEnd > guardIdx, '找不到 nginx -t 保护块的结尾，测试本身失效');
  const block = sh.slice(guardIdx, guardEnd);
  assert.match(block, /mv -f "\$backup" "\$NGINX_SITE"/, '失败时必须还原上一版站点配置');
  assert.match(block, /rm -f "\$NGINX_SITE"/, '没有旧配置时必须撤销站点文件');
  // 软链：只有**部署前就有**软链才还原它；没有才删（别删掉不是自己创建的软链）
  assert.match(block, /rm -f "\$NGINX_LINK"/, '回滚时必须处理软链（没有旧软链就删掉）');
  assert.match(sh, /link_before="\$\(readlink "\$NGINX_LINK"\)"/, '必须记住软链在部署前的指向（回滚要还原它）');
});

test('会话有效期：环境文件必须写绝对过期变量，且默认值与真实代码一致', () => {
  const sh = read('install.sh');
  const unit = read('heikesong.service');
  // 变量名从真实代码里取，不写死（代码改名时这条测试必须跟着变）
  const absVar = (sessionSrc.match(/process\.env\.([A-Z_]*ABSOLUTE_TTL_DAYS)/) || [])[1];
  assert.ok(absVar, '读不到 src/auth/session.js 的绝对过期变量名，测试本身失效');
  assert.match(sh, new RegExp(`printf '${absVar}=%s`), `环境文件必须写 ${absVar}（不写就静默用代码默认值）`);
  assert.match(unit, new RegExp(absVar), `systemd 单元的环境文件注释必须列出 ${absVar}`);
  // 默认值必须与代码里的默认值一致
  const codeDefault = (sessionSrc.match(/DEFAULT_ABSOLUTE_TTL_DAYS\s*=\s*(\d+)/) || [])[1];
  assert.ok(codeDefault, '读不到代码里的默认绝对过期天数，测试本身失效');
  assert.match(
    sh,
    new RegExp(`${absVar}="\\$\\{${absVar}:-${codeDefault}\\}"`),
    `默认值必须与代码一致（${codeDefault} 天），否则「文件里写的」≠「生效的」`,
  );
  // 非法值必须 fail-fast（代码对非法值是**静默**回退到默认值 ⇒ 环境文件写错没人会发现）
  assert.match(sh, /validate_session_ttls/, '必须有会话天数的合法性校验');
  assert.match(sh, /validate_session_ttls\n/, 'main() 必须真的调用它');
});

test('nginx HTTP/2 兼容：旧版本自动降级、新版本保留（真跑脚本，不看注释）', () => {
  const compatPath = join(deployDir, 'nginx-http2-compat.sh');
  assert.ok(existsSync(compatPath), '必须存在 deploy/nginx-http2-compat.sh');
  const tmp = mkdtempSync(join(tmpdir(), 'heikesong-nginx-'));
  try {
    const run = (version) => {
      const out = join(tmp, `conf-${version}`);
      execFileSync('bash', [compatPath, join(deployDir, 'nginx.conf'), out], {
        env: { ...process.env, NGINX_VERSION: version },
        encoding: 'utf8',
      });
      return readFileSync(out, 'utf8');
    };
    // 旧版（Ubuntu 24.04 = nginx 1.24.0）：必须降级
    const old = run('1.24.0');
    assert.match(old, /^\s*listen 443 ssl http2;$/m, '旧版 nginx 必须降级成 listen ... ssl http2;');
    assert.match(old, /^\s*listen \[::\]:443 ssl http2;$/m, 'IPv6 那一支也必须降级');
    assert.doesNotMatch(old, /^\s*http2 on;$/m, '⛔ 旧版 nginx 不认 `http2 on;`，残留就是必然 nginx -t 失败');
    // 临界前一版：1.25.1 才引入该指令，1.25.0 一样不认
    const justUnder = run('1.25.0');
    assert.doesNotMatch(justUnder, /^\s*http2 on;$/m, '1.25.0 仍不认 `http2 on;`（该指令 1.25.1 引入）');
    assert.match(justUnder, /^\s*listen 443 ssl http2;$/m, '1.25.0 必须降级');
    // 新版：保留原写法
    const neu = run('1.25.1');
    assert.match(neu, /^\s*http2 on;$/m, '≥ 1.25.1 必须保留 `http2 on;`');
    assert.match(neu, /^\s*listen 443 ssl;$/m, '≥ 1.25.1 不应改动 listen 行');
    // 端口 80 的 listen 不能被误改（降级只针对 443）
    const old80 = run('1.24.0');
    assert.match(old80, /^\s*listen 80;$/m, '80 端口的 listen 不能被降级脚本改掉');
    assert.match(old80, /^\s*listen \[::\]:80;$/m, '80 端口的 IPv6 listen 不能被降级脚本改掉');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // install.sh 必须真的调用它（否则兼容脚本只是一份没人用的文档）
  assert.match(read('install.sh'), /nginx-http2-compat\.sh/, 'install.sh 必须调用兼容脚本');
});

test('前端产物目录口径：唯一构建产物目录是 web/dist/，nginx 的 web/assets/ 是预留位', () => {
  const conf = read('nginx.conf');
  const sh = read('install.sh');
  // ⛔ nginx 不得再声称 web/assets/ 是「前端构建产物目录」—— 那个目录是 web/dist/
  assert.doesNotMatch(
    conf,
    /web\/assets\/[^\n]*是【前端构建产物目录】/,
    '⛔ web/assets/ 不是构建产物目录（构建产物在 web/dist/）',
  );
  assert.match(conf, /web\/dist/, 'nginx.conf 必须写明真正的构建产物目录是 web/dist/');
  assert.match(sh, /--exclude 'web\/dist\/'/, 'install.sh 必须排除构建产物目录（它是发布物，不随程序同步）');
  assert.match(sh, /--exclude 'web\/assets\/'/, 'install.sh 必须排除预留的静态资源目录');
});

test('nginx HTTP/2 兼容：自动探测必须认得 nginx 真实输出格式（回归 D7-4）', () => {
  const compatPath = join(deployDir, 'nginx-http2-compat.sh');
  const tmp = mkdtempSync(join(tmpdir(), 'heikesong-nginxver-'));
  try {
    // 造一个假 nginx：`-v` 把版本号打在 **stderr**，格式与官方构建一致
    // （`nginx version: nginx/1.24.0 (Ubuntu)` —— 版本号前有 `nginx/` 前缀）。
    const fakeBin = join(tmp, 'bin');
    mkdirSync(fakeBin, { recursive: true });

    // ⚠️ 版本号要**烤进**假脚本里：真 nginx 是 `nginx -v` 被调用（**无参数**），
    //    假脚本若写 `nginx/$1` 会输出成 `nginx version: nginx/ (Ubuntu)` —— 那是假失败。
    const run = (version) => {
      const fakeNginx = join(fakeBin, 'nginx');
      writeFileSync(fakeNginx, `#!/bin/sh\necho "nginx version: nginx/${version} (Ubuntu)" >&2\nexit 0\n`);
      chmodSync(fakeNginx, 0o755);
      const out = join(tmp, `auto-${version}`);
      const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
      delete env.NGINX_VERSION;            // ⛔ 不给覆盖 ⇒ 走**自动探测**这条真实路径
      execFileSync('bash', [compatPath, join(deployDir, 'nginx.conf'), out], { env, encoding: 'utf8' });
      return readFileSync(out, 'utf8');
    };

    // 旧版：必须被**探测到**并降级（不是靠「探测不到 ⇒ 保守降级」蒙对）
    const old = run('1.24.0');
    assert.match(old, /^\s*listen 443 ssl http2;$/m, '探测到 1.24.0 必须降级');
    assert.doesNotMatch(old, /^\s*http2 on;$/m, '1.24.0 不认 `http2 on;`');
    // 新版：必须被**探测到**并保留（这条最关键 —— 探测失败会误降级）
    const neu = run('1.25.1');
    assert.match(neu, /^\s*http2 on;$/m, '探测到 1.25.1 必须保留 `http2 on;`（探测失败会误降级）');
    assert.match(neu, /^\s*listen 443 ssl;$/m, '探测到 1.25.1 不应改动 listen 行');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 真跑 install.sh 的函数（看**行为**，不看注释）────────────────────────────
//
// 为什么要真跑：下面这两条的正确性**在注释里看不见、也盖不住** ——
//   ① bash 的整数比较在超过 2^63-1 时会报 "integer expression expected"，
//      运维看到的第一行会变成 bash 噪音而不是可执行的提示；
//   ② 回滚时软链的**部署前原状**能不能还原，只有真跑才知道。
// 正则断言盖不住这两点（它们都在 shell 的**运行期**才暴露）。

/**
 * 在沙箱里 source install.sh（去掉末尾的 `main "$@"`）并执行一段 shell 片段。
 * @param {string} body  在 install.sh 的函数都加载好之后执行的 shell 片段
 * @param {object} env   追加的环境变量
 * @param {object} opts  { nginxTestFails: boolean } —— nginx -t 是否一律失败
 * @returns {{code:number, out:string}}
 */
function runInstallShell(body, env = {}, opts = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'heikesong-install-'));
  try {
    // 去掉末尾的 `main "$@"`（否则它会去改机器状态）
    writeFileSync(join(tmp, 'install.sh'), read('install.sh').replace(/^main "\$@"$/m, ''));

    const binDir = join(tmp, 'bin');
    mkdirSync(binDir, { recursive: true });
    const nginxStub = join(binDir, 'nginx');
    writeFileSync(
      nginxStub,
      opts.nginxTestFails
        ? '#!/bin/sh\nif [ "$1" = "-t" ]; then echo "nginx: [emerg] unknown directive \\"http2\\"" >&2; exit 1; fi\necho "nginx version: nginx/1.24.0 (Ubuntu)" >&2\nexit 0\n'
        : '#!/bin/sh\necho "nginx version: nginx/1.24.0 (Ubuntu)" >&2\nexit 0\n',
    );
    chmodSync(nginxStub, 0o755);

    // ⚠️ 必须给 `rm` 打个桩：某些开发环境把 `rm` shim 成「可恢复删除」
    //    （走 osascript + Finder，**每次要好几秒**，有时还会卡住）⇒
    //    install.sh 的回滚路径里那两条 `rm -f` 会把测试拖成分钟级。
    //    这里让桩直接调**真正的** /bin/rm：被测的是**逻辑**（删没删对东西），
    //    不是「删除是否可恢复」。
    const realRm = ['/bin/rm', '/usr/bin/rm'].find((p) => existsSync(p)) || 'rm';
    const rmStub = join(binDir, 'rm');
    writeFileSync(rmStub, `#!/bin/sh\nexec ${realRm} "$@"\n`);
    chmodSync(rmStub, 0o755);

    const script = [
      'set -uo pipefail',
      `export PATH="${binDir}:$PATH"`,
      'export NGINX_SITE="${HKS_TMP}/etc/nginx/sites-available/heikesong.conf"',
      'export NGINX_LINK="${HKS_TMP}/etc/nginx/sites-enabled/heikesong.conf"',
      'export SERVER_NAME="t.example.com"',
      'export APP_DIR="${HKS_TMP}/app"',
      'export DATA_DIR="${HKS_TMP}/data"',
      'export CERT_PATH="${HKS_TMP}/c.pem"',
      'export KEY_PATH="${HKS_TMP}/k.pem"',
      'mkdir -p "$(dirname "$NGINX_SITE")" "$(dirname "$NGINX_LINK")"',
      'source "${HKS_TMP}/install.sh"',
      // source 之后 SCRIPT_DIR/ROOT 是按 $0 算的（source 时 $0 是 bash）⇒ 必须改回来
      `SCRIPT_DIR="${deployDir}"`,
      `ROOT="${join(here, '..')}"`,
      `NGINX_COMPAT_SCRIPT="${deployDir}/nginx-http2-compat.sh"`,
      'set +e',
      body,
    ].join('\n');

    const res = spawnSync('bash', ['-c', script], {
      env: { ...process.env, HKS_TMP: tmp, ...env },
      encoding: 'utf8',
    });
    return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('会话有效期：非法值必须报**人话**（不得先吐 bash 的整数比较噪音）', () => {
  const probe = (ttl, abs) =>
    runInstallShell('validate_session_ttls', {
      SESSION_TTL_DAYS: ttl,
      SESSION_ABSOLUTE_TTL_DAYS: abs,
    });

  // ① 合法值放行（含「更严配置」与前导零 —— 不得过度加规则）
  for (const [ttl, abs, why] of [
    ['7', '30', '常规'],
    ['1', '1', '最小值'],
    ['7', '3', '绝对上限 < 滑动有效期是合法的更严配置'],
    ['007', '030', '前导零'],
  ]) {
    const r = probe(ttl, abs);
    assert.equal(r.code, 0, `${why}（ttl=${ttl} abs=${abs}）必须放行，实际 exit=${r.code}：${r.out}`);
  }

  // ② 非正整数必须 fail-fast，且提示是**人话**
  const cases = [
    ['0', '30', /必须 > 0/],
    ['7', '0', /必须 > 0/],
    ['abc', '30', /必须是正整数/],
    ['3.5', '30', /必须是正整数/],
    ['-1', '30', /必须是正整数/],
  ];
  for (const [ttl, abs, expect] of cases) {
    const r = probe(ttl, abs);
    assert.notEqual(r.code, 0, `ttl=${ttl} abs=${abs} 必须 fail-fast`);
    assert.match(r.out, expect, `ttl=${ttl} abs=${abs} 的提示不对：${r.out}`);
    assert.doesNotMatch(
      r.out,
      /integer expression expected/,
      `ttl=${ttl} abs=${abs} 的第一行不能是 bash 的整数比较噪音：${r.out}`,
    );
  }

  // ②' 空串**不是**非法值：install.sh 顶层的 `${SESSION_TTL_DAYS:-7}` 会把空串
  //     换成默认值 7 ⇒ 放行。这里钉的是「空串走默认值」这条既有口径，别被误改成报错。
  const empty = probe('', '30');
  assert.equal(empty.code, 0, `空串应走默认值（放行），实际 exit=${empty.code}：${empty.out}`);

  // ③ 超长数字：bash 的整数比较会溢出 ⇒ 必须先被上界挡下，且**不吐** bash 噪音
  const big = probe('99999999999999999999', '30');
  assert.notEqual(big.code, 0, '超长数字必须 fail-fast');
  assert.doesNotMatch(
    big.out,
    /integer expression expected/,
    `超长数字的第一行不能是 bash 噪音：${big.out}`,
  );
  assert.match(big.out, /不能超过/, `超长数字必须给出「超出上界」的人话提示：${big.out}`);

  // ④ 上界本身必须真的存在（否则 ③ 是被别的分支挡下的）
  const over = probe('3651', '30');
  assert.notEqual(over.code, 0, '超过上界的天数必须 fail-fast');
  assert.match(over.out, /不能超过/, over.out);
});

test('nginx 回滚：不得删掉**不是自己创建的**软链（部署前原状必须还原）', () => {
  // ① 预置的软链指向**别的**文件 ⇒ 回滚后必须还原成原来的指向
  const withPreexisting = runInstallShell(
    [
      'OTHER="${HKS_TMP}/etc/nginx/sites-available/OTHER.conf"',
      'printf "OTHER\\n" > "$OTHER"',
      'ln -sfn "$OTHER" "$NGINX_LINK"',
      // ⚠️ 必须放**子 shell**：write_nginx_site 失败时 die() 会 exit 整个脚本，
      //    直接调用的话后面的断言行根本执行不到（out 会是空的）。
      '( write_nginx_site ) >/dev/null 2>&1',
      'echo "EXIT=$?"',
      'if [ -L "$NGINX_LINK" ]; then echo "LINK=$(readlink "$NGINX_LINK")"; else echo "LINK=GONE"; fi',
      'if [ -e "$OTHER" ]; then echo "OTHER=KEPT"; else echo "OTHER=DELETED"; fi',
      'if [ -e "$NGINX_SITE" ]; then echo "SITE=KEPT"; else echo "SITE=REMOVED"; fi',
    ].join('\n'),
    {},
    { nginxTestFails: true },
  );
  assert.match(withPreexisting.out, /EXIT=1/, `nginx -t 失败必须退出非 0：${withPreexisting.out}`);
  assert.match(
    withPreexisting.out,
    /LINK=.*OTHER\.conf/,
    `回滚必须把软链还原成部署前的指向，不能删掉它：${withPreexisting.out}`,
  );
  assert.match(withPreexisting.out, /OTHER=KEPT/, '不能删掉别人的文件');
  assert.match(withPreexisting.out, /SITE=REMOVED/, '本次写入的新配置必须被撤销');

  // ② 预置软链**不存在** ⇒ 回滚后软链也不该残留
  const withoutPreexisting = runInstallShell(
    [
      '( write_nginx_site ) >/dev/null 2>&1',
      'echo "EXIT=$?"',
      'if [ -L "$NGINX_LINK" ]; then echo "LINK=STILL-THERE"; else echo "LINK=REMOVED"; fi',
    ].join('\n'),
    {},
    { nginxTestFails: true },
  );
  assert.match(withoutPreexisting.out, /LINK=REMOVED/, `回滚后不得残留坏软链：${withoutPreexisting.out}`);
  assert.match(withoutPreexisting.out, /EXIT=1/, withoutPreexisting.out);
});

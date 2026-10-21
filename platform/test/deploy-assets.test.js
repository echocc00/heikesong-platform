import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

#!/usr/bin/env bash
# deploy/install.sh — 一键部署（幂等）
#
# 依据：设计文档 §14.2「deploy/install.sh（一键：装 Node → 写 service → 配 nginx → 建库 → 初始化管理员账号）」
#
# ✅ 幂等：可重复执行不炸（用户/目录/文件已存在 → 跳过或覆盖，不报错）。
# ⛔ 不硬编码任何口令：管理员口令来自环境变量 ADMIN_PASSWORD，或交互读取（不回显）。
#    环境文件 /etc/heikesong/platform.env 里【不放口令】——口令只用于初始化那一次。
#
# 用法（【不要】把口令写进本文件，也不要提交进仓库）：
#   sudo SERVER_NAME=heikesong.example.com \
#        CERT_PATH=/etc/letsencrypt/live/heikesong.example.com/fullchain.pem \
#        KEY_PATH=/etc/letsencrypt/live/heikesong.example.com/privkey.pem \
#        ./deploy/install.sh
#   → 不给 ADMIN_PASSWORD 时，脚本会交互读取口令（不回显，仅用于这一次初始化）。
#   → 想免交互：在你自己的 shell 里 export ADMIN_PASSWORD（值当场填，
#     【不要】写进本文件 / 仓库 / 命令历史），再用 sudo -E 调用本脚本。
#
# 全部变量（都有默认值，见下）：
#   APP_DIR       程序目录            默认 /opt/heikesong/platform
#   DATA_DIR      数据目录            默认 /var/lib/heikesong/data
#   SERVICE_NAME  systemd 服务名       默认 heikesong
#   RUN_USER      运行用户            默认 heikesong
#   SERVER_NAME   正式域名            默认空（空 = 跳过 nginx 配置）
#   CERT_PATH     证书路径            默认 /etc/letsencrypt/live/<域名>/fullchain.pem
#   KEY_PATH      私钥路径            默认 /etc/letsencrypt/live/<域名>/privkey.pem
#   ADMIN_PHONE   管理员手机号         默认 13800000000
#   ADMIN_PASSWORD 管理员口令          默认空（空 = 交互读取）
#   ENV_FILE      环境文件路径         默认 /etc/heikesong/platform.env
#   NGINX_SITE    nginx 站点文件       默认 /etc/nginx/sites-available/heikesong.conf
#   NGINX_LINK    nginx 站点软链       默认 /etc/nginx/sites-enabled/heikesong.conf
#   SYSTEMD_UNIT_DIR systemd 单元目录  默认 /etc/systemd/system
#
# ⚠️ 端口口径：8080 是**写死**的口径（与 deploy/nginx.conf 的 upstream、
#    systemd 单元的 Environment=PORT、docker-compose 的 PORT 同一套）。
#    要换端口必须四处一起改 —— 本脚本不提供 PORT 变量，避免只改一处连不上。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"     # platform/ 根目录
APP_DIR="${APP_DIR:-/opt/heikesong/platform}"
DATA_DIR="${DATA_DIR:-/var/lib/heikesong/data}"
SERVICE_NAME="${SERVICE_NAME:-heikesong}"
RUN_USER="${RUN_USER:-heikesong}"
SERVER_NAME="${SERVER_NAME:-}"
ENV_FILE="${ENV_FILE:-/etc/heikesong/platform.env}"
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/heikesong.conf}"
NGINX_LINK="${NGINX_LINK:-/etc/nginx/sites-enabled/heikesong.conf}"
SYSTEMD_UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
# ⛔ Node 下限 = 22.16.0（package.json engines）。22.16.0 是 node:sqlite.backup()
#    的引入版本 —— 备份脚本（P6 Task 1）依赖它，低版本装了也跑不了备份。
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=16

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] 错误：%s\n' "$*" >&2; exit 1; }

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "需要 root 权限（请用 sudo 运行）"
  fi
}

node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor rest
  v="$(node -p 'process.versions.node')"
  major="${v%%.*}"
  rest="${v#*.}"
  minor="${rest%%.*}"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then return 1; fi
  if [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -lt "$MIN_NODE_MINOR" ]; then return 1; fi
  return 0
}

# sed 替换文本转义：反斜杠 / & / | 在替换文本里必须转义，
# 否则路径里的特殊字符会被 sed 当成自己的语法（& = 整个匹配）。
sed_escape() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

install_node() {
  log "安装 Node.js 24（生产建议；代码在 22 与 24 上都能跑）"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main\n' \
      > /etc/apt/sources.list.d/nodesource.list
    apt-get update -y
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs npm
  else
    die "未识别的包管理器：请手动安装 Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} 后重跑本脚本"
  fi
}

create_service_user() {
  if id -u "$RUN_USER" >/dev/null 2>&1; then
    log "运行用户 $RUN_USER 已存在，跳过"
    return 0
  fi
  log "创建系统用户 $RUN_USER"
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home-dir "$(dirname "$DATA_DIR")" --shell /usr/sbin/nologin "$RUN_USER"
  else
    adduser -S -D -H -h "$(dirname "$DATA_DIR")" -s /sbin/nologin "$RUN_USER"
  fi
}

# 运行用户的主组：落盘时用它，而不是「与用户名同名的组」——
# 同名组是 Debian/RHEL 上 useradd 的默认行为，但不是通用假设
# （例如 macOS 的主组是 staff，install -g <用户名> 会直接报 unknown group）。
run_group() {
  id -gn "$RUN_USER" 2>/dev/null || printf '%s' "$RUN_USER"
}

prepare_dirs() {
  local group
  group="$(run_group)"
  install -d -m 0755 "$APP_DIR"
  install -d -m 0750 -o "$RUN_USER" -g "$group" "$DATA_DIR"
  install -d -m 0750 -o "$RUN_USER" -g "$group" "$DATA_DIR/backups"
}

copy_app() {
  log "同步程序到 $APP_DIR"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude 'data/' --exclude 'node_modules/' --exclude '.git/' --exclude 'web/dist/' \
      "$ROOT/" "$APP_DIR/"
  else
    # 没有 rsync 时的兜底：先删后拷（不删 data/）
    find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name 'data' -exec rm -rf {} +
    cp -a "$ROOT/." "$APP_DIR/"
  fi
}

write_env_file() {
  log "写环境文件 $ENV_FILE"
  install -d -m 0750 "$(dirname "$ENV_FILE")"
  # umask 收窄到 077 再写文件，写完恢复 —— 否则 umask 会漏到后面的
  # nginx 站点文件上（那个文件 nginx 主进程以 root 读，但 600 的配置
  # 会让「非 root 的配置检查工具」读不了）。
  local old_umask
  old_umask="$(umask)"
  umask 077
  {
    printf 'PORT=8080\n'
    printf 'DATA_DIR=%s\n' "$DATA_DIR"
    printf 'SESSION_TTL_DAYS=7\n'
    # ⚠️ NODE_ENV=production 会让登录 Cookie 带 Secure 标记
    #    （src/server.js: secureCookies = NODE_ENV === 'production'）——
    #    「IP + 端口 + 纯 HTTP」的调试形态下浏览器会直接拒收 Cookie → 登录失效。
    #    那种形态请用 NODE_ENV=development 调用本脚本。
    printf 'NODE_ENV=%s\n' "${NODE_ENV:-production}"
  } > "$ENV_FILE"
  umask "$old_umask"
  chmod 0640 "$ENV_FILE"
  chown root:"$(run_group)" "$ENV_FILE" 2>/dev/null || true
  # ⛔ 这里【不写】任何口令：口令只在初始化管理员时用一次，不落盘。
}

as_service_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUN_USER" -- "$@"
  else
    local cmd=""
    for a in "$@"; do cmd="$cmd $(printf '%q' "$a")"; done
    su -s /bin/sh -c "$cmd" "$RUN_USER"
  fi
}

init_database() {
  log "建库 + 迁移（以运行用户执行，避免库文件属主变成 root）"
  ( cd "$APP_DIR" && as_service_user env DATA_DIR="$DATA_DIR" node scripts/migrate.js )

  local phone="${ADMIN_PHONE:-13800000000}"
  local password="${ADMIN_PASSWORD:-}"
  if [ -z "$password" ]; then
    printf '请输入管理员口令（不回显，仅用于本次初始化，不写入任何文件）：'
    # ⚠️ 读不到（stdin 不是终端 / 已关闭）时 read 返回非 0 ——
    #    在 set -e 下会让脚本直接死掉，报错信息还很难懂，所以吞掉退出码，
    #    交给下面的空值检查给出人话。
    read -rs password || true
    printf '\n'
  fi
  [ -n "$password" ] || die "未提供管理员口令（ADMIN_PASSWORD 环境变量或交互输入）"
  log "初始化能力点 / 角色 / 管理员账号（手机号 ${phone}）"
  ( cd "$APP_DIR" && as_service_user env DATA_DIR="$DATA_DIR" ADMIN_PHONE="$phone" ADMIN_PASSWORD="$password" node scripts/seed.js )
  unset password
}

write_systemd_unit() {
  log "写 systemd 单元 $SERVICE_NAME"
  install -d -m 0755 "$SYSTEMD_UNIT_DIR"
  sed -e "s|__APP_DIR__|$(sed_escape "$APP_DIR")|g" \
      -e "s|__DATA_DIR__|$(sed_escape "$DATA_DIR")|g" \
      -e "s|__RUN_USER__|$(sed_escape "$RUN_USER")|g" \
      -e "s|/etc/heikesong/platform.env|$(sed_escape "$ENV_FILE")|g" \
      "$ROOT/deploy/heikesong.service" > "$SYSTEMD_UNIT_DIR/$SERVICE_NAME.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
}

write_nginx_site() {
  if [ -z "$SERVER_NAME" ]; then
    log "跳过 nginx：未设置 SERVER_NAME（正式对外域名）"
    return 0
  fi
  log "写 nginx 站点配置 $NGINX_SITE"
  install -d -m 0755 "$(dirname "$NGINX_SITE")" "$(dirname "$NGINX_LINK")"
  local cert="${CERT_PATH:-/etc/letsencrypt/live/$SERVER_NAME/fullchain.pem}"
  local key="${KEY_PATH:-/etc/letsencrypt/live/$SERVER_NAME/privkey.pem}"
  sed -e "s|__SERVER_NAME__|$(sed_escape "$SERVER_NAME")|g" \
      -e "s|__CERT_PATH__|$(sed_escape "$cert")|g" \
      -e "s|__KEY_PATH__|$(sed_escape "$key")|g" \
      -e "s|__APP_DIR__|$(sed_escape "$APP_DIR")|g" \
      "$ROOT/deploy/nginx.conf" > "$NGINX_SITE"
  ln -sfn "$NGINX_SITE" "$NGINX_LINK"
  nginx -t                 # ⛔ 先验配置再 reload：配置错了不炸线上
  if systemctl reload nginx 2>/dev/null; then
    log "nginx 已 reload"
  else
    systemctl restart nginx
    log "nginx 已重启"
  fi
}

start_service() {
  log "启动服务 $SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  sleep 1
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "服务运行中。健康检查： curl -s http://127.0.0.1:8080/api/health"
  else
    log "服务未处于 active 状态，请看日志： journalctl -u $SERVICE_NAME -n 50 --no-pager"
    return 1
  fi
}

main() {
  need_root
  if ! node_version_ok; then
    install_node
  fi
  node_version_ok || die "Node 版本仍不满足要求（需要 >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}）"

  [ -f "$ROOT/deploy/heikesong.service" ] || die "缺少 $ROOT/deploy/heikesong.service（脚本必须在 platform/deploy/ 下）"
  [ -f "$ROOT/deploy/nginx.conf" ] || die "缺少 $ROOT/deploy/nginx.conf（脚本必须在 platform/deploy/ 下）"

  create_service_user
  prepare_dirs
  copy_app
  write_env_file
  init_database
  write_systemd_unit
  start_service
  write_nginx_site

  log "部署完成。"
  log "  程序目录：$APP_DIR"
  log "  数据目录：$DATA_DIR"
  # 备份脚本是 P6 Task 1 的产物：还没落地就不打印这条命令，免得给出跑不通的提示。
  if [ -f "$APP_DIR/scripts/backup.js" ]; then
    log "  备份命令： cd $APP_DIR && DATA_DIR=$DATA_DIR node scripts/backup.js"
  fi
  log "  查看日志： journalctl -u $SERVICE_NAME -f"
}

main "$@"

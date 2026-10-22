#!/usr/bin/env bash
# deploy/deploy-demo-site.sh — 发布「公网演示站」（静态包）：构建 + 写 nginx 站点 + 校验
#
# 依据：P6 Task 6 的「公网演示站」产物（scripts/build-demo.js 的输出），
#    以及部署手册 §18「公网演示站（静态包）的发布」。
#
# ✅ 这个脚本做什么（**只做静态站，不碰平台本体**）：
#    ① 用**同一台机器上的同一份源码**构建静态包（rules/src/web 全从 APP_DIR 取）
#       ⇒ 演示站与平台本体永远同步，不存在「演示站是旧版本」的问题；
#    ② 把静态包放到 DEMO_DIR；
#    ③ 渲染并写入 nginx 站点（只发静态文件，**不代理平台 API**）；
#    ④ nginx -t 通过后 reload；**不通过就回滚**；
#    ⑤ 实跑校验（首页 200 + 静态资源 200）。
#
# ⛔ 边界（很重要）：
#    · **不碰**平台本体的站点文件（heikesong.conf / heikesong-tls.conf）
#      ⇒ 演示站发布失败不会影响平台对外；
#    · 演示站是**独立端口、独立 origin** ⇒ cookie / localStorage 与平台互不串；
#    · 演示站**不代理任何后端** ⇒ 演示站碰不到平台的 API。
#
# 用法（【不要】把证书路径写进本文件）：
#   sudo SERVER_NAME=8.133.200.235 \
#        CERT_PATH=/etc/letsencrypt/live/8.133.200.235/fullchain.pem \
#        KEY_PATH=/etc/letsencrypt/live/8.133.200.235/privkey.pem \
#        ./platform/deploy/deploy-demo-site.sh
#
# 全部变量（都有默认值）：
#   APP_DIR       平台源码目录          默认 /opt/heikesong/platform（构建用的源码在这）
#   DEMO_DIR      静态包输出目录        默认 /opt/heikesong/demo
#   DEMO_PORT     演示站对外端口        默认 8445
#   SERVER_NAME   server_name           默认空（**必填**，否则站点没有 server_name）
#   CERT_PATH     证书路径              默认 /etc/letsencrypt/live/<SERVER_NAME>/fullchain.pem
#   KEY_PATH      私钥路径              默认 /etc/letsencrypt/live/<SERVER_NAME>/privkey.pem
#   NGINX_SITE    nginx 站点文件        默认 /etc/nginx/sites-available/heikesong-demo.conf
#   NGINX_LINK    nginx 站点软链        默认 /etc/nginx/sites-enabled/heikesong-demo.conf
#   NGINX_TEMPLATE 站点模板             默认 deploy/nginx-demo-static.conf
#   SKIP_BUILD=1  跳过构建（只重写站点配置）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${APP_DIR:-/opt/heikesong/platform}"
DEMO_DIR="${DEMO_DIR:-/opt/heikesong/demo}"
DEMO_PORT="${DEMO_PORT:-8445}"
SERVER_NAME="${SERVER_NAME:-}"
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/heikesong-demo.conf}"
NGINX_LINK="${NGINX_LINK:-/etc/nginx/sites-enabled/heikesong-demo.conf}"
NGINX_TEMPLATE="${NGINX_TEMPLATE:-$SCRIPT_DIR/nginx-demo-static.conf}"
# HTTP/2 兼容脚本：`http2 on;` 要 nginx ≥ 1.25.1（这台机是 1.22.1 ⇒ 不认这个指令，
# nginx -t 会报 unknown directive 并**让整个 nginx 起不来**）⇒ 渲染前先跑兼容层，
# 由它按**目标机**的 nginx 版本自动降级成 `listen <端口> ssl http2;`。
NGINX_COMPAT_SCRIPT="${NGINX_COMPAT_SCRIPT:-$SCRIPT_DIR/nginx-http2-compat.sh}"
SKIP_BUILD="${SKIP_BUILD:-}"
CERT_PATH="${CERT_PATH:-/etc/letsencrypt/live/$SERVER_NAME/fullchain.pem}"
KEY_PATH="${KEY_PATH:-/etc/letsencrypt/live/$SERVER_NAME/privkey.pem}"

log() { printf '[demo-site] %s\n' "$*"; }
die() { printf '[demo-site] 错误：%s\n' "$*" >&2; exit 1; }

# sed 替换文本转义：反斜杠 / & / | 在替换文本里必须转义
sed_escape() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

# ── ① 构建静态包 ──────────────────────────────────────────────────────
build_demo() {
  if [ -n "$SKIP_BUILD" ]; then
    log "跳过构建（SKIP_BUILD=${SKIP_BUILD}）"
    return 0
  fi
  [ -f "$APP_DIR/scripts/build-demo.js" ] || die "缺少 $APP_DIR/scripts/build-demo.js（先跑 install.sh）"
  log "构建静态包：$APP_DIR → $DEMO_DIR"
  # ⚠️ 在 APP_DIR 下执行：build-demo.js 用 process.cwd() 解析 --out 的相对路径
  ( cd "$APP_DIR" && node scripts/build-demo.js --out "$DEMO_DIR" )
  [ -f "$DEMO_DIR/index.html" ] || die "构建产物里没有 index.html：$DEMO_DIR/index.html"
}

# ── ② 写 nginx 站点（备份 → 渲染 → nginx -t → reload，失败回滚）──────
write_site() {
  log "写 nginx 站点配置 ${NGINX_SITE}（模板 ${NGINX_TEMPLATE}，端口 ${DEMO_PORT}）"
  install -d -m 0755 "$(dirname "$NGINX_SITE")" "$(dirname "$NGINX_LINK")"

  # 备份旧站点文件：nginx -t 失败时要**回滚**，不能把一份坏配置留在 sites-enabled 里
  # （那会毒化这台机器上**下一次**任何 nginx reload —— 哪怕跟这次发布无关）。
  local backup="" link_before=""
  if [ -f "$NGINX_SITE" ]; then
    backup="$(mktemp "${TMPDIR:-/tmp}/heikesong-demo-site.XXXXXX")"
    cp -p "$NGINX_SITE" "$backup"
  fi
  # ⚠️ 软链的**部署前原状**也要记：它可能早就存在且指向别的文件。
  if [ -L "$NGINX_LINK" ]; then
    link_before="$(readlink "$NGINX_LINK")"
  fi

  # ① 先做 HTTP/2 语法兼容（与 install.sh 同一套、同一顺序：**先兼容、后替换占位符**）
  #    ⚠️ 顺序不能反：兼容脚本看到的永远是 `listen __TLS_PORT__ ssl;` 这种占位符形态。
  [ -f "$NGINX_COMPAT_SCRIPT" ] || die "缺少 ${NGINX_COMPAT_SCRIPT}（HTTP/2 兼容脚本）"
  local rendered
  rendered="$(mktemp "${TMPDIR:-/tmp}/heikesong-demo-rendered.XXXXXX")"
  if ! bash "$NGINX_COMPAT_SCRIPT" "$NGINX_TEMPLATE" "$rendered"; then
    rm -f "$rendered"
    die "nginx HTTP/2 兼容处理失败（见上面的 [nginx-compat] 输出）"
  fi

  sed -e "s|__SERVER_NAME__|$(sed_escape "$SERVER_NAME")|g" \
      -e "s|__CERT_PATH__|$(sed_escape "$CERT_PATH")|g" \
      -e "s|__KEY_PATH__|$(sed_escape "$KEY_PATH")|g" \
      -e "s|__TLS_PORT__|$(sed_escape "$DEMO_PORT")|g" \
      -e "s|__DEMO_DIR__|$(sed_escape "$DEMO_DIR")|g" \
      "$rendered" > "$NGINX_SITE"
  rm -f "$rendered"
  ln -sfn "$NGINX_SITE" "$NGINX_LINK"

  # ⛔ 先验配置再 reload
  if ! nginx -t; then
    if [ -n "$backup" ] && [ -f "$backup" ]; then
      mv -f "$backup" "$NGINX_SITE"
      log "已回滚到上一版演示站配置"
    else
      rm -f "$NGINX_SITE"
      log "已撤销本次演示站配置（此前没有旧配置）"
    fi
    if [ -n "$link_before" ]; then
      ln -sfn "$link_before" "$NGINX_LINK"
    else
      rm -f "$NGINX_LINK"
    fi
    die "nginx 配置校验失败（nginx -t 返回非 0）——已回滚，请按上面的 nginx -t 输出修正后重跑本脚本"
  fi
  [ -n "$backup" ] && rm -f "$backup"

  if systemctl reload nginx 2>/dev/null; then
    log "nginx 已 reload"
  else
    systemctl restart nginx
    log "nginx 已重启"
  fi
}

# ── ③ 实跑校验 ────────────────────────────────────────────────────────
probe() {
  curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 10 \
    --resolve "$SERVER_NAME:$DEMO_PORT:127.0.0.1" "https://$SERVER_NAME:$DEMO_PORT$1"
}

verify_site() {
  local root_code index_code app_code
  root_code="$(probe /)"
  index_code="$(probe /index.html)"
  app_code="$(probe /web/app.js)"
  log "首页 $root_code ｜ index.html $index_code ｜ web/app.js $app_code"
  if [ "$root_code" != "200" ] || [ "$index_code" != "200" ] || [ "$app_code" != "200" ]; then
    die "演示站校验未通过（首页 $root_code / index $index_code / app.js ${app_code}）—— 站点已上线但内容不可取，请查 nginx 错误日志"
  fi
}

# ── 前置校验（动任何东西之前）──────────────────────────────────────────
validate() {
  [ -n "$SERVER_NAME" ] || die "必须给 SERVER_NAME（演示站要有一个 server_name；用 IP 就填 IP）"
  [ -f "$NGINX_TEMPLATE" ] || die "缺少站点模板：$NGINX_TEMPLATE"
  [ -d "$APP_DIR" ] || die "平台源码目录不存在：${APP_DIR}（先跑 install.sh）"

  # ⛔ DEMO_DIR 不得与 APP_DIR 相同或在其内部：
  #    install.sh 的 copy_app 用 `rsync --delete` 同步源码 ⇒ 放在里面的产物会被删掉。
  case "$DEMO_DIR" in
    "$APP_DIR"|"$APP_DIR"/*) die "DEMO_DIR 不得在 APP_DIR 内部（$APP_DIR 会被 rsync --delete 覆盖）：$DEMO_DIR" ;;
  esac

  # ⛔ 端口必须是合法端口号（1–65535）。
  case "$DEMO_PORT" in
    ''|*[!0-9]*) die "DEMO_PORT 必须是 1-65535 的整数，实际：$DEMO_PORT" ;;
  esac
  if [ "$DEMO_PORT" -lt 1 ] || [ "$DEMO_PORT" -gt 65535 ]; then
    die "DEMO_PORT 必须在 1-65535 之间，实际：$DEMO_PORT"
  fi

  [ -f "$CERT_PATH" ] || die "证书不存在：${CERT_PATH}（用 CERT_PATH / KEY_PATH 指定）"
  [ -f "$KEY_PATH" ] || die "私钥不存在：${KEY_PATH}（用 CERT_PATH / KEY_PATH 指定）"
}

main() {
  # ⛔ 先查前置条件，再动任何东西（写 /etc/nginx、构建产物都在后面）
  [ "$(id -u)" -eq 0 ] || die "需要 root 权限（请用 sudo 运行）"
  validate
  build_demo
  write_site
  verify_site
  log "演示站发布完成： https://$SERVER_NAME:$DEMO_PORT/"
  log "  静态包目录：$DEMO_DIR"
  log "  提示：演示站数据**不跨人共享**（每个浏览器独立计算）；平台本体在另一个端口、另一套数据。"
}

main "$@"

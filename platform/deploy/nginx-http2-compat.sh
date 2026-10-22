#!/usr/bin/env bash
# deploy/nginx-http2-compat.sh — HTTP/2 指令的 nginx 版本兼容层
#
# 背景：deploy/nginx.conf 用的是 `http2 on;`，**nginx ≥ 1.25.1** 才认识这个指令；
#   1.25.1 之前只认 `listen 443 ssl http2;` 这一种写法。
#   发行版现状：Ubuntu 22.04 = nginx 1.18.x、Ubuntu 24.04 = nginx 1.24.0
#   —— 都 < 1.25.1。直接用本仓库的 nginx.conf，`nginx -t` 会报
#   "unknown directive \"http2\""，而这一步在 install.sh 的**最后**，
#   于是部署变成「装完了才炸」，还把一份坏配置留在 sites-enabled 里
#   （那会毒化这台机器上**下一次**任何 nginx reload）。
#   本脚本按**目标机**的 nginx 版本把配置改写成该版本认识的语法。
#
# 用法：
#   nginx-http2-compat.sh <输入 conf> <输出 conf>
#   两种走法：
#     · 版本够新（≥ 1.25.1）⇒ 原样拷贝（保留 `http2 on;`）
#     · 版本偏旧         ⇒ 降级：删掉独立的 `http2 on;` 行，
#                          并把 `listen ... <端口> ssl;` 改成 `listen ... <端口> ssl http2;`
#                          （旧语法在**所有** nginx 版本上都合法 ⇒ 降级永远安全）
#
# ⚠️ 端口为什么不能写死成 443：
#    ① deploy/nginx-tls-port.conf 用的是**占位符** `__TLS_PORT__`（端口由
#      install.sh 的 NGINX_TLS_PORT 注入，常见值 8444 / 9443 等自定义口）。
#    ② ⚠️ **顺序陷阱**：install.sh 是**先跑本脚本、后替换占位符** ——
#      本脚本看到的永远是 `listen __TLS_PORT__ ssl;` 这种**占位符形态**，
#      不是替换后的真实端口。
#    ⇒ 若这里只匹配 443，占位符形态匹配不上 ⇒ 降级时 `http2 on;` 被删掉、
#      `http2` 又没补回 listen 行 ⇒ **HTTP/2 被静默丢弃**（功能不坏，但
#      与模板声明的形态不符，且没人会发现）。
#    ⇒ 故此处匹配「任意数字端口」或占位符 `__TLS_PORT__`。
#
# 环境变量：
#   NGINX_VERSION  覆盖探测到的版本（形如 1.24.0）。默认用 `nginx -v` 探测；
#                  探测不到时按「需要降级」处理（保守：降级后的语法处处合法）。
#                  显式给出这个变量的另一个用途是「在没装 nginx 的机器上预演渲染结果」。
#
# 退出码：0 成功；2 用法错 / 输入文件不存在 / 降级后仍残留 `http2 on;`。
set -euo pipefail

# `http2 on;` 的引入版本：nginx 1.25.1
MIN_NGINX_MAJOR=1
MIN_NGINX_MINOR=25
MIN_NGINX_PATCH=1

usage() {
  printf '用法：nginx-http2-compat.sh <输入 conf> <输出 conf>\n' >&2
}

if [ "$#" -ne 2 ]; then
  usage
  exit 2
fi

IN_CONF="$1"
OUT_CONF="$2"

if [ ! -f "$IN_CONF" ]; then
  printf '[nginx-compat] 错误：输入文件不存在：%s\n' "$IN_CONF" >&2
  exit 2
fi

# ── 探测版本 ────────────────────────────────────────────────────────────
detect_version() {
  if [ -n "${NGINX_VERSION:-}" ]; then
    printf '%s' "$NGINX_VERSION"
    return 0
  fi
  if command -v nginx >/dev/null 2>&1; then
    # nginx -v 把版本号打在 **stderr**。
    # ⚠️ 真实输出是 `nginx version: nginx/1.24.0 (Ubuntu)` —— 版本号前有 `nginx/` 前缀
    #    （官方构建的 VERSION 串就是 "nginx/" + 版本号）。只写 `nginx version: 1.24.0`
    #    的正则**匹配不到** ⇒ 真机上永远探测失败、永远走保守降级。
    #    ⇒ 这里两种形态都要吃下（用 POSIX BRE 的 \{0,1\}，BSD sed（macOS）也认）。
    nginx -v 2>&1 | sed -n 's|^nginx version: *\(nginx/\)\{0,1\}\([0-9][0-9.]*\).*|\2|p' | head -n 1
    return 0
  fi
  printf ''
}

VERSION="$(detect_version)"

version_supports_http2_on() {
  # $1 = 版本号（形如 1.24.0 / 1.25.1）；空 = 探测不到 ⇒ 判「不支持」⇒ 降级
  local v="$1" major minor patch
  [ -n "$v" ] || return 1
  major="${v%%.*}"
  local rest="${v#*.}"
  minor="${rest%%.*}"
  local rest2="${rest#*.}"
  case "$rest2" in
    ''|*[!0-9]*) patch=0 ;;
    *) patch="${rest2%%.*}" ;;
  esac
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  case "$minor" in ''|*[!0-9]*) return 1 ;; esac
  if [ "$major" -ne "$MIN_NGINX_MAJOR" ]; then
    [ "$major" -gt "$MIN_NGINX_MAJOR" ]
    return
  fi
  if [ "$minor" -ne "$MIN_NGINX_MINOR" ]; then
    [ "$minor" -gt "$MIN_NGINX_MINOR" ]
    return
  fi
  [ "$patch" -ge "$MIN_NGINX_PATCH" ]
}

# ── 渲染 ────────────────────────────────────────────────────────────────
# 先记住输入里**独立成行**的 `http2 on;` 有没有（注释里提到的不算）
had_http2_on=0
if grep -qE '^[[:space:]]*http2[[:space:]]+on;[[:space:]]*$' "$IN_CONF"; then
  had_http2_on=1
fi

if version_supports_http2_on "$VERSION"; then
  cp "$IN_CONF" "$OUT_CONF"
  printf '[nginx-compat] nginx %s ≥ %s.%s.%s：保留 `http2 on;` 写法\n' \
    "$VERSION" "$MIN_NGINX_MAJOR" "$MIN_NGINX_MINOR" "$MIN_NGINX_PATCH"
  # 保持路径的自检：输入有 `http2 on;` ⇒ 输出必须也有（不能被悄悄改掉）
  out_http2_on=0
  if grep -qE '^[[:space:]]*http2[[:space:]]+on;[[:space:]]*$' "$OUT_CONF"; then
    out_http2_on=1
  fi
  if [ "$had_http2_on" -ne "$out_http2_on" ]; then
    printf '[nginx-compat] 错误：保持路径下 `http2 on;` 指令丢失（输入有=%s，输出有=%s）\n' \
      "$had_http2_on" "$out_http2_on" >&2
    exit 2
  fi
else
  # 用 awk 而不是 sed：sed 的 BRE 扩展（\+ / \d）在 BSD sed（macOS）上不通用，
  # 而本脚本要在 macOS 上被测试实跑，必须可移植。
  awk '
    # 删掉独立的 `http2 on;` 行（前后允许空白）
    /^[[:space:]]*http2[[:space:]]+on;[[:space:]]*$/ { next }
    {
      line = $0
      # 把 `listen [::]:443 ssl;` / `listen 443 ssl;` 改成 `... ssl http2;`
      # ⚠️ IPv6 那一支是 `[::]:443` —— `]` 后面还有一个 `:`，正则必须带上它
      if (line ~ /^[[:space:]]*listen[[:space:]]+(\[[^]]*\]:[[:space:]]*)?([0-9]+|__TLS_PORT__)[[:space:]]+ssl;[[:space:]]*$/) {
        sub(/;[[:space:]]*$/, " http2;", line)
        changed = 1
      }
      print line
    }
  ' "$IN_CONF" > "$OUT_CONF"
  printf '[nginx-compat] nginx %s < %s.%s.%s：已降级为 `listen ... ssl http2;`（旧语法在所有版本都合法）\n' \
    "${VERSION:-未探测到（按需降级处理）}" "$MIN_NGINX_MAJOR" "$MIN_NGINX_MINOR" "$MIN_NGINX_PATCH"
  # 降级路径的自检：**绝不能**还残留独立的 `http2 on;`（否则 nginx -t 必然失败）
  if grep -qE '^[[:space:]]*http2[[:space:]]+on;[[:space:]]*$' "$OUT_CONF"; then
    printf '[nginx-compat] 错误：输出里仍残留独立的 `http2 on;`，该 nginx 版本不认这个指令\n' >&2
    exit 2
  fi
fi

exit 0

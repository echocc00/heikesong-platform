// src/http/static.js — 静态文件服务
// 依据：设计文档 §14.2。生产环境静态资源由 nginx 直出，这里是内网/本地兜底。
import { createReadStream, openSync, fstatSync, closeSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function serveStatic(webDir, req, res) {
  const url = (req.url || '/').split('?')[0];
  let rel;
  try {
    rel = decodeURIComponent(url === '/' ? '/index.html' : url);
  } catch {
    // 畸形百分号编码 → 不当静态资源处理
    return false;
  }
  // ⛔ 预审修正（C7-1）：路径段里显式拒绝 '..'。
  //    必须在 decode **之后**判，否则 %2e%2e 能绕过。
  if (rel.split('/').some((seg) => seg === '..')) return false;

  // 防目录穿越（三重）：
  // ① rel 以 '/' 开头时用 '.' 前缀，resolve 不会把它当成绝对路径
  // ② 前缀比较必须带分隔符边界：'/x/web-secret'.startsWith('/x/web') 为真，
  //    只比前缀会把 web 的**兄弟目录**也放进来（预审实测 200 + 兄弟目录文件内容）
  const root = resolve(webDir);
  const relPath = rel.startsWith('/') ? rel : `/${rel}`;
  const target = resolve(root, `.${relPath}`);
  if (target !== root && !target.startsWith(root + sep)) return false;

  // ⛔ 终审修正（Important，I-1）：**符号链接逃逸**。
  //    上面的边界比较只作用于**路径字符串** —— resolve() 规范化路径但
  //    **不解析符号链接**。web/ 下一个指向根外的软链（部署脚本把 data/ 软链进
  //    web/、静态资源目录指向共享卷）会让 web 根之外的文件被 HTTP 读走。
  //    终审实测：ln -s /etc web/etclink → GET /etclink/passwd → 200 + /etc/passwd 全文。
  //    这里把**根**与**目标**都解析成真实路径再比一次边界。
  let realRoot;
  let realTarget;
  let linkStat;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(target);
    linkStat = statSync(realTarget);
  } catch {
    // 目标不存在（404）或根不存在 → 不当静态资源处理
    return false;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return false;

  // ⚠️ **先打开再取元数据**，而不是 statSync 之后再 open：
  //    stat 与 open 之间存在 TOCTOU 窗口 —— 「热部署时先删掉整个 web 目录、
  //    再拷入新版本」正好落在这个窗口里，open 失败 → 读流抛出一个**无人监听的
  //    error 事件** → Node 视为未捕获异常 → **整个服务器进程退出**（评审实测
  //    退出码 1、客户端零响应）。
  //    用已经打开的 fd 就没有这个窗口了；打不开（权限不足 / 已删除）直接交给上层回 404。
  let fd;
  let stat;
  try {
    fd = openSync(target, 'r');
    stat = fstatSync(fd);
  } catch {
    return false;
  }
  if (!stat.isFile()) {
    closeSync(fd);
    return false;
  }
  // ⚠️ realpath → open 之间仍有一个窗口：软链可能被换成别的文件。
  //    用 dev/ino 对账堵住 —— 打开后的 inode 必须与 realpath 看到的一致。
  if (!isSameFile(stat, linkStat)) {
    closeSync(fd);
    return false;
  }

  const ext = extname(target).toLowerCase();
  const etag = `W/"${stat.size}-${stat.mtimeMs.toString(36)}"`;
  if (req.headers && req.headers['if-none-match'] === etag) {
    // ⚠️ fd 已经在上面打开了 → 这里必须关掉，否则每次 304 都漏一个 fd
    closeSync(fd);
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  pipeFd(res, fd);
  return true;
}

/**
 * 判断两个 stat 是否指向**同一个文件**（dev + ino 对账）。
 *
 * ⛔ 终审修正（Important，I-1）：realpath 与 open 之间存在 TOCTOU 窗口 ——
 *    软链可能在两步之间被换成别的文件。用 dev/ino 对账把窗口堵上。
 *
 * 单独导出是为了能**直接测这条防线**：竞态本身无法稳定复现，
 *    但「两个不同的文件不得被判为同一个」可以钉死。
 *    （dev+ino 是 POSIX 的文件身份；跨平台稳定 —— Windows 下同样有 ino，
 *      拿不到时 dev/ino 相同仍会走同一条拒绝路径，不影响正确性。）
 */
export function isSameFile(statA, statB) {
  if (!statA || !statB) return false;
  return statA.dev === statB.dev && statA.ino === statB.ino;
}

/**
 * 用已打开的 fd 建流并写回响应。
 *
 * ⚠️ autoClose 让 Node 自己关 fd（手动再关会撞 EBADF，
 *    而 EBADF 恰好就是「未监听的 error 事件」→ 进程死亡的一种形态）。
 *
 * ⛔ 评审修正（Important）：读流**必须挂 error 监听**。
 *    没有监听时，任何读错误（权限、瞬时 I/O 错误、fd 被外部关闭）都会变成
 *    **未捕获异常** → 整个服务器进程退出。此时响应头已经发出去了，
 *    只能断开连接 —— 但**绝不能**让它冒泡成进程级异常。
 *
 * 导出是为了能单独测这条 error 路径（用无效 fd 触发 EBADF）。
 */
export function pipeFd(res, fd) {
  const stream = createReadStream(null, { fd, autoClose: true });
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
  return stream;
}

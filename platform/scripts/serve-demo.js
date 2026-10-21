// scripts/serve-demo.js — 本地预览演示站构建产物
// 溯源需求：R-OPS-06（公网可访问：发布前在本机把产物跑起来看一眼）
// 用途：发布前在本机把 web/dist/ 跑起来看一眼（不启后端、不建库）。
// 用法：node scripts/serve-demo.js   → http://127.0.0.1:8090/
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../src/http/static.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web', 'dist');
const port = Number(process.env.PORT || 8090);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && serveStatic(webDir, req, res)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 页面不存在（演示站只有静态资源）');
});

server.listen(port, () => {
  console.log(`演示站本地预览：http://127.0.0.1:${port}/`);
});

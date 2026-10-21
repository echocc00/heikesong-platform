// src/domain/icalendar.js — RFC 5545 日历文本生成（纯函数）
// 依据：设计文档 §8「公开榜单 API + 赛程 iCal 订阅」；INTERFACES.md §6 `buildICalendar`
// 溯源：R-STG-01（5 赛段时间轴与交付物）—— iCal 把「赛段时间轴」变成机器可读、可订阅的形态
// 借鉴：dribdat 的 iCal 实现思路（MIT）——但【自己写】：
//   零依赖约束（R-OPS-07：只用 Node 标准库），且 dribdat 的实现依赖 Django 生态。
// ⛔ 纯函数：无 IO、无 Date.now()、无 Math.random()。now 由调用方传入。
//
// 四个必须处理的点（少一个，主流日历客户端就会拒收整个文件）：
//   ① 行折叠：每行 ≤ 75 octets，续行以一个空格开头
//   ② 转义：逗号 / 分号 / 反斜杠 / 换行（先转义反斜杠，否则会把前面的转义符再转义一次）
//   ③ 行尾：CRLF
//   ④ 时间戳：YYYYMMDDTHHMMSSZ（UTC）
export const ICAL_LINE_MAX_OCTETS = 75;

// ⚠️ ⛔ 领域层必须在**浏览器**里跑同一套引擎（P6 的演示版把 src/domain/*.js 原样拷进浏览器产物）
//    ⇒ 不得用 Node 专属全局（Buffer / process / require / __dirname / __filename）——
//    浏览器里 `Buffer is not defined` ⇒ 整个模块直接 ReferenceError。
//    TextEncoder / TextDecoder 是 **WHATWG Web 标准**（Node ≥ 11 起也是全局）⇒ 两端通用，
//    且**不需要 import 任何 Node 内置模块**。
//    ⚠️ `build-demo.js` 的 `assertDomainIsBrowserSafe` 只查 import 说明符、不查 Node 全局
//    ⇒ 这类违规它查不出来（见计划文档 T5-C9）。
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export function escapeICalText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

export function formatICalTimestamp(value) {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new Error(`非法时间戳：${value}`);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * 行折叠：超过 75 octets 的行拆成多行，续行以一个空格开头。
 * ⚠️ 不能把一个多字节字符劈成两半（中文标题很容易踩这个坑）。
 */
export function foldICalLine(line) {
  const text = String(line ?? '');
  const bytes = ENCODER.encode(text);
  if (bytes.length <= ICAL_LINE_MAX_OCTETS) return text;

  const parts = [];
  let start = 0;
  let limit = ICAL_LINE_MAX_OCTETS;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // 回退到字符边界：bytes[end] 若是续接字节（10xxxxxx）说明劈开了多字节字符
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(DECODER.decode(bytes.subarray(start, end)));
    start = end;
    limit = ICAL_LINE_MAX_OCTETS - 1; // 续行首字符是空格，占 1 octet
  }
  return parts.map((p, i) => (i === 0 ? p : ` ${p}`)).join('\r\n');
}

export function buildICalendarText({
  calName = '赛事赛程',
  prodId = '-//heikesong//platform//CN',
  events = [],
  now,
}) {
  if (!now) throw new Error('buildICalendarText 需要 now 参数（领域层不读时钟）');
  const stamp = formatICalTimestamp(now);

  const lines = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push(`PRODID:${prodId}`);
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push(`X-WR-CALNAME:${escapeICalText(calName)}`);

  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (ev.start) lines.push(`DTSTART:${formatICalTimestamp(ev.start)}`);
    if (ev.end) lines.push(`DTEND:${formatICalTimestamp(ev.end)}`);
    lines.push(`SUMMARY:${escapeICalText(ev.summary ?? '')}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeICalText(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${escapeICalText(ev.location)}`);
    if (ev.url) lines.push(`URL:${escapeICalText(ev.url)}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldICalLine).join('\r\n')}\r\n`;
}

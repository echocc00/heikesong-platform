// platform/test/icalendar.test.js — iCal 日历导出（手写 RFC 5545，零依赖）
// 依据：设计文档 §8「公开榜单 API + 赛程 iCal 订阅」；INTERFACES.md §6 `buildICalendar`
// 溯源：R-STG-01（5 赛段时间轴与交付物）—— 赛段起止时间轴能被日历客户端订阅
//
// ⚠️ 本文件同时覆盖【两层】：
//   ① 领域纯函数（src/domain/icalendar.js）：转义 / 折叠 / 时间戳
//   ② HTTP 路由（GET /api/public/calendar.ics）：token 鉴权 + 原文响应（__rawText）
//   计划原块只覆盖领域层与���务层 ⇒ 路由零覆盖（同 Task 4 的 T4-C2 同款病根），此处补齐。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/sqlite.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadRules } from '../src/config.js';
import { createApp } from '../src/server.js';
import {
  buildICalendarText, formatICalTimestamp, escapeICalText, foldICalLine,
} from '../src/domain/icalendar.js';
import { buildICalendar, createPublicToken } from '../src/services/public-api.js';
import { call } from '../test-helpers/http-call.js';
import { stripComments } from '../test-helpers/strip-comments.js';
import { isolateTempDir } from '../test-helpers/tmp.js';

// ⚠️ 隔离本进程临时目录：进程退出时整体回收（防临时目录泄漏，详见 test-helpers/tmp.js）
isolateTempDir();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const rulesDir = join(here, '..', 'rules');
const webDir = join(here, '..', 'web');
// 统一注入时间：领域层不读时钟，所有时间断言都基于它，口径可复算
const NOW = '2026-10-20T00:00:00.000Z';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hks-p5ics-'));
  const { db, close } = openDatabase({ dataDir });
  applyMigrations(db, migrationsDir);
  const { rules } = loadRules(rulesDir);
  db.exec(`
    INSERT INTO editions (id, name, city, starts_at, ends_at, created_at)
    VALUES ('ed_1', '第一届 · 杭州', '杭州', '2026-10-01', '2026-10-31', '2026-10-01T00:00:00.000Z');
    INSERT INTO stages (id, edition_id, key, name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
    VALUES ('st_1', 'ed_1', 's1', '调研', 'initial', '2026-10-01', '2026-10-10', NULL, 'initial', 'computed'),
           ('st_2', 'ed_1', 's2', '任务', 'initial', '2026-10-10', '2026-10-13', NULL, 'initial', 'computed'),
           ('st_3', 'ed_1', 's3', '开发', 'initial', '2026-10-13', '2026-10-25', NULL, 'initial', 'open');
  `);
  const app = createApp({ db, rules, webDir });
  return { db, close, dataDir, rules, app };
}

function cleanup(db, close, dataDir) {
  close();
  rmSync(dataDir, { recursive: true, force: true });
}

/** 基本解析器：先取消折叠，再切 VEVENT 块 */
function unfold(ics) {
  return ics.replace(/\r\n[ \t]/g, '');
}

function parseEvents(ics) {
  const flat = unfold(ics);
  return flat.split('BEGIN:VEVENT').slice(1).map((block) => {
    const body = block.split('END:VEVENT')[0];
    const fields = {};
    for (const line of body.split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      fields[line.slice(0, idx).split(';')[0]] = line.slice(idx + 1);
    }
    return fields;
  });
}

/** 追加一个赛段（给「长标题」「含特殊字符」等场景用） */
function addStage(db, { id, key, name, startsAt = '2026-10-01', endsAt = '2026-10-10' }) {
  db.prepare(
    `INSERT INTO stages (id, edition_id, "key", name, kind, starts_at, ends_at, freeze_at, scoring_config_key, status)
     VALUES (?, 'ed_1', ?, ?, 'initial', ?, ?, NULL, 'initial', 'computed')`,
  ).run(id, key, name, startsAt, endsAt);
}

/** 签发一个公开令牌（明文只在这里返回一次） */
function publicToken(db, { scope = 'calendar', editionId = 'ed_1', expiresAt = '2099-01-01T00:00:00.000Z' } = {}) {
  return createPublicToken({ db, scope, editionId, expiresAt, now: NOW }).token;
}

test('VEVENT 数 = 赛段数（基本解析器能读出来）', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
  const events = parseEvents(ics);
  assert.equal(events.length, 3);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
  cleanup(db, close, dataDir);
});

test('每个事件都有 UID / DTSTAMP / DTSTART / DTEND / SUMMARY，时间戳是 YYYYMMDDTHHMMSSZ', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
  for (const ev of parseEvents(ics)) {
    assert.ok(ev.UID, '缺 UID');
    assert.match(ev.DTSTAMP, /^\d{8}T\d{6}Z$/);
    assert.match(ev.DTSTART, /^\d{8}T\d{6}Z$/);
    assert.match(ev.DTEND, /^\d{8}T\d{6}Z$/);
    assert.ok(ev.SUMMARY, '缺 SUMMARY');
  }
  cleanup(db, close, dataDir);
});

test('行尾是 CRLF，没有裸 LF', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: '2026-10-20T00:00:00.000Z' });
  assert.equal(ics.replace(/\r\n/g, '').includes('\n'), false, '不允许裸 LF');
  assert.equal(ics.replace(/\r\n/g, '').includes('\r'), false, '不允许裸 CR');
  cleanup(db, close, dataDir);
});

test('每行 ≤ 75 octets（RFC 5545 行折叠）', () => {
  const ics = buildICalendarText({
    calName: '第一届',
    events: [{
      uid: 'stage-1@heikesong.local',
      summary: '这是一个非常非常非常长的赛段标题，用来触发 RFC 5545 的行折叠规则，必须被折成多行，否则客户端会拒收整个文件',
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-10-10T00:00:00.000Z',
    }],
    now: '2026-10-20T00:00:00.000Z',
  });
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `行太长（${Buffer.byteLength(line, 'utf8')} octets）：${line.slice(0, 40)}…`);
  }
});

test('长行被折叠，续行以一个空格开头，取消折叠后内容还原', () => {
  const summary = '长标题'.repeat(60);
  const ics = buildICalendarText({
    events: [{ uid: 'u1', summary, start: '2026-10-01T00:00:00.000Z' }],
    now: '2026-10-20T00:00:00.000Z',
  });
  const physical = ics.split('\r\n');
  assert.ok(physical.some((l) => l.startsWith(' ')), '必须有续行');
  const flat = unfold(ics);
  assert.ok(flat.includes(`SUMMARY:${summary}`), '取消折叠后内容必须还原');
});

test('逗号 / 分号 / 反斜杠 / 换行被转义', () => {
  assert.equal(escapeICalText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  const ics = buildICalendarText({
    events: [{ uid: 'u1', summary: 'A,B;C\\D', start: '2026-10-01T00:00:00.000Z' }],
    now: '2026-10-20T00:00:00.000Z',
  });
  assert.ok(ics.includes('SUMMARY:A\\,B\\;C\\\\D'), '文本里的特殊字符必须转义');
});

test('formatICalTimestamp 输出 UTC 秒级时间戳', () => {
  assert.equal(formatICalTimestamp('2026-10-01T09:30:00.000Z'), '20261001T093000Z');
  assert.equal(formatICalTimestamp(new Date('2026-12-31T23:59:59.000Z')), '20261231T235959Z');
});

test('foldICalLine 不劈开多字节字符', () => {
  const line = `SUMMARY:${'赛段'.repeat(80)}`;
  const folded = foldICalLine(line);
  for (const part of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(part, 'utf8') <= 75);
    assert.equal(part.includes('\uFFFD'), false, '不能出现乱码（说明字符被劈开了）');
  }
  assert.equal(folded.replace(/\r\n /g, ''), line, '取消折叠后必须还原');
});

test('折叠宽度用满 75 octets（首段 75 octets；续行 = 74 octets 内容 + 1 个前导空格；末段是余量）', () => {
  const line = `SUMMARY:${'a'.repeat(200)}`;
  const folded = foldICalLine(line);
  const parts = folded.split('\r\n');
  assert.equal(Buffer.byteLength(parts[0], 'utf8'), 75, '首段必须用满 75 octets');
  for (const p of parts.slice(1, -1)) {
    assert.equal(Buffer.byteLength(p, 'utf8'), 75, '续行 = 74 octets 内容 + 1 个前导空格');
  }
  const last = Buffer.byteLength(parts[parts.length - 1], 'utf8');
  assert.ok(last > 0 && last <= 75, `末段是余量，实际 ${last}`);
  assert.equal(folded.replace(/\r\n /g, ''), line);
});

// ── 以下为 P5 Task 5 实跑后补齐的用例（计划原块只覆盖领域层与���务层，
//    新建的 GET /api/public/calendar.ics 路由**零覆盖**）──

test('buildICalendarText 不给 now → 抛错（领域层不读时钟，时间必须由调用方注入）', () => {
  assert.throws(
    () => buildICalendarText({ events: [{ uid: 'u1', start: '2026-10-01T00:00:00.000Z' }] }),
    /now/,
    '缺 now 必须抛错，不能默默取当前时间',
  );
});

test('领域层是纯函数：icalendar.js 不 import node: 内置模块、不用 Date.now()/Math.random()', () => {
  const src = readFileSync(join(here, '..', 'src', 'domain', 'icalendar.js'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/from\s+['"]node:/.test(code), false, '领域层不得 import Node 内置模块');
  assert.equal(/\bDate\.now\s*\(/.test(code), false, '领域层不得用 Date.now()');
  assert.equal(/\bMath\.random\s*\(/.test(code), false, '领域层不得用 Math.random()');
  assert.equal(/new Date\s*\(\s*\)/.test(code), false, '领域层不得无参构造 Date');
});

test('★ 领域层不含 Node 专属全局：Buffer / process / require / __dirname / __filename', () => {
  // ⚠️ 为什么钉这一条：P6 的演示版把 `src/domain/*.js` **原样拷进浏览器产物**
  //    （platform/scripts/build-demo.js）⇒ 领域层必须在**浏览器**里跑同一套引擎。
  //    `Buffer` 是 Node 专属全局 —— 浏览器里 `Buffer is not defined` ⇒ 整个模块 ReferenceError。
  //    ⛔ `build-demo.js` 的 `assertDomainIsBrowserSafe` **只查 import 说明符、不查 Node 全局**
  //    ⇒ 这类违规它查不出来（见计划文档 T5-C9）。所以这里补一条静态扫描把它钉住。
  const banned = [
    { re: /\bBuffer\b/, name: 'Buffer' },
    { re: /\bprocess\s*\./, name: 'process.' },
    { re: /\brequire\s*\(/, name: 'require(' },
    { re: /\b__dirname\b/, name: '__dirname' },
    { re: /\b__filename\b/, name: '__filename' },
  ];
  const dir = join(here, '..', 'src', 'domain');
  const files = readdirSync(dir).filter((n) => n.endsWith('.js'));
  assert.ok(files.length > 0, '领域层目录不该是空的');
  for (const name of files) {
    // 先剥注释：注释里提到 Buffer 不算「用了 Buffer」
    const code = stripComments(readFileSync(join(dir, name), 'utf8'));
    for (const b of banned) {
      assert.equal(
        b.re.test(code),
        false,
        `src/domain/${name} 不得使用 Node 专属全局 ${b.name}（浏览器里不存在）`,
      );
    }
  }
});

test('★ 换成 TextEncoder/TextDecoder 后折叠语义不变：每行 ≤ 75 UTF-8 字节，拼接后与原文逐字相等', () => {
  const original = `SUMMARY:${'华东区赛段：需求评审与原型验证'.repeat(9)}`;
  const folded = foldICalLine(original);
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1, '长中文标题必须被折成多行');
  for (const line of lines) {
    assert.ok(
      Buffer.byteLength(line, 'utf8') <= 75,
      `行太长（${Buffer.byteLength(line, 'utf8')} octets）`,
    );
    assert.equal(line.includes('\uFFFD'), false, '不能出现乱码（说明字符被劈开了）');
  }
  // 取消折叠后必须与原文逐字相等（证明换字节 API 没改语义）
  assert.equal(folded.replace(/\r\n /g, ''), original);
});

test('escapeICalText 的空值口径是空串（不是 "null"/"undefined" 字面量）', () => {
  assert.equal(escapeICalText(null), '');
  assert.equal(escapeICalText(undefined), '');
  assert.equal(escapeICalText(''), '');
});

test('formatICalTimestamp 遇到非法时间 → 抛错（不静默产出一个坏时间戳）', () => {
  assert.throws(() => formatICalTimestamp('not-a-date'), /非法时间戳/);
  assert.throws(() => formatICalTimestamp(''), /非法时间戳/);
});

test('每个事件带 DESCRIPTION / LOCATION / URL（赛段说明、赛点、榜单跳转）', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  const events = parseEvents(ics);
  for (const ev of events) {
    assert.ok(ev.DESCRIPTION, '缺 DESCRIPTION');
    assert.ok(ev.LOCATION, '缺 LOCATION');
    assert.ok(ev.URL, '缺 URL');
  }
  assert.equal(events[0].LOCATION, '杭州', '赛点取届期城市');
  assert.ok(events[0].URL.includes('stageId=st_1'), 'URL 必须指向该赛段');
  assert.ok(events[0].DESCRIPTION.includes('s1'), 'DESCRIPTION 必须带赛段代号');
  assert.ok(events[0].DESCRIPTION.includes('调研'), 'DESCRIPTION 必须带赛段名');
  cleanup(db, close, dataDir);
});

test('同样的输入产出同样的字节（可复算：不掺入真实时钟）', () => {
  const { db, close, dataDir } = setup();
  const a = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  const b = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  assert.equal(a, b, '同一个 now 必须产出逐字相同的日历');
  const c = buildICalendar({ db, editionId: 'ed_1', now: '2026-10-21T00:00:00.000Z' });
  assert.notEqual(a, c, 'now 变了 DTSTAMP 必须变');
  assert.ok(c.includes('DTSTAMP:20261021T000000Z'));
  cleanup(db, close, dataDir);
});

test('日历头字段齐全：VERSION / PRODID / CALSCALE / METHOD / X-WR-CALNAME', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  assert.ok(ics.includes('VERSION:2.0\r\n'));
  assert.ok(ics.includes('PRODID:-//heikesong//platform//CN\r\n'));
  assert.ok(ics.includes('CALSCALE:GREGORIAN\r\n'));
  assert.ok(ics.includes('METHOD:PUBLISH\r\n'));
  assert.ok(ics.includes('X-WR-CALNAME:第一届 · 杭州\r\n'), '日历名取届期名');
  cleanup(db, close, dataDir);
});

test('每个赛段一个 VEVENT：UID 唯一且可追溯到赛段 id', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  const events = parseEvents(ics);
  const uids = events.map((e) => e.UID);
  assert.equal(new Set(uids).size, uids.length, 'UID 必须唯一（重复 UID 客户端会互相覆盖）');
  assert.deepEqual(uids.sort(), ['stage-st_1@heikesong.local', 'stage-st_2@heikesong.local', 'stage-st_3@heikesong.local']);
  cleanup(db, close, dataDir);
});

test('赛段起止时间落到 DTSTART/DTEND（日期串按 UTC 零点解析）', () => {
  const { db, close, dataDir } = setup();
  const ics = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  const events = parseEvents(ics);
  assert.equal(events[0].DTSTART, '20261001T000000Z');
  assert.equal(events[0].DTEND, '20261010T000000Z');
  assert.equal(events[2].DTEND, '20261025T000000Z');
  cleanup(db, close, dataDir);
});

test('赛段名里的逗号/分号/反斜杠在服务层同样被转义（不只在纯函数层）', () => {
  const { db, close, dataDir } = setup();
  addStage(db, { id: 'st_x', key: 'sx', name: 'A,B;C\\D' });
  const ics = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  assert.ok(ics.includes('SUMMARY:A\\,B\\;C\\\\D（sx）'), '特殊字符必须转义');
  cleanup(db, close, dataDir);
});

test('超长赛段名在服务层同样被折叠（且不劈开多字节字符）', () => {
  const { db, close, dataDir } = setup();
  addStage(db, { id: 'st_long', key: 'sl', name: '长'.repeat(80) });
  const ics = buildICalendar({ db, editionId: 'ed_1', now: NOW });
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `行太长：${Buffer.byteLength(line, 'utf8')}`);
    assert.equal(line.includes('\uFFFD'), false, '不能出现乱码');
  }
  assert.ok(unfold(ics).includes(`SUMMARY:${'长'.repeat(80)}（sl）`), '取消折叠后必须还原');
  cleanup(db, close, dataDir);
});

test('buildICalendar 缺 editionId → 400 EDITION_REQUIRED（不静默出一份空日历）', () => {
  const { db, close, dataDir } = setup();
  assert.throws(
    () => buildICalendar({ db, now: NOW }),
    (err) => err.status === 400 && err.code === 'EDITION_REQUIRED',
  );
  cleanup(db, close, dataDir);
});

test('HTTP GET /api/public/calendar.ics：带 token → 200 + text/calendar + 原文 CRLF', async () => {
  const s = setup();
  const token = publicToken(s.db);
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?editionId=ed_1&token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200, res.body);
  assert.equal(res.headers['Content-Type'], 'text/calendar; charset=utf-8');
  assert.ok(res.body.startsWith('BEGIN:VCALENDAR\r\n'), '必须是原文，不是 JSON 字符串');
  assert.ok(res.body.endsWith('END:VCALENDAR\r\n'));
  assert.equal(res.body.includes('\\r\\n'), false, '原文不能被 JSON 转义');
  assert.equal(res.body.replace(/\r\n/g, '').includes('\n'), false, '不允许裸 LF');
  assert.equal(parseEvents(res.body).length, 3);
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：无 token → 403 PUBLIC_TOKEN_MISSING（公开 ≠ 无鉴权）', async () => {
  const s = setup();
  const res = await call(s.app, 'GET', '/api/public/calendar.ics?editionId=ed_1');
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_TOKEN_MISSING');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：scope 不符 → 403 PUBLIC_TOKEN_SCOPE_MISMATCH', async () => {
  const s = setup();
  const token = publicToken(s.db, { scope: 'leaderboard' });
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?editionId=ed_1&token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_TOKEN_SCOPE_MISMATCH');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：跨届期 token → 403 PUBLIC_TOKEN_EDITION_MISMATCH', async () => {
  const s = setup();
  const token = publicToken(s.db, { editionId: 'ed_other' });
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?editionId=ed_1&token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_TOKEN_EDITION_MISMATCH');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：过期 token → 403 PUBLIC_TOKEN_EXPIRED', async () => {
  const s = setup();
  const token = createPublicToken({
    db: s.db, scope: 'calendar', editionId: 'ed_1',
    expiresAt: '2026-10-19T00:00:00.000Z', now: '2026-10-01T00:00:00.000Z',
  }).token;
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?editionId=ed_1&token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'PUBLIC_TOKEN_EXPIRED');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：缺 editionId → 400 EDITION_REQUIRED', async () => {
  const s = setup();
  const token = publicToken(s.db);
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 400, res.body);
  assert.equal(JSON.parse(res.body).error.code, 'EDITION_REQUIRED');
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：该届期没有赛段 → 200 + 空日历（列表 → 200 + 空集）', async () => {
  const s = setup();
  s.db.exec("INSERT INTO editions (id, name, city, starts_at, ends_at, created_at) VALUES ('ed_2', '第二届', '上海', '2026-11-01', '2026-11-30', '2026-10-01T00:00:00.000Z')");
  const token = publicToken(s.db, { editionId: 'ed_2' });
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?editionId=ed_2&token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200, res.body);
  assert.equal(parseEvents(res.body).length, 0);
  assert.ok(res.body.startsWith('BEGIN:VCALENDAR\r\n'));
  cleanup(s.db, s.close, s.dataDir);
});

test('HTTP GET /api/public/calendar.ics：日历里不泄露企业名与内部身份（公开面只给赛段时间轴）', async () => {
  const s = setup();
  s.db.exec(`
    INSERT INTO users (id, name, phone, password_hash, mba_status, org, is_superadmin, active, created_at)
    VALUES ('u_a', '甲', '13900000051', 'x', 'mba', '学堂', 0, 1, '2026-10-01T00:00:00.000Z');
    INSERT INTO task_packages (id, edition_id, enterprise_id, enterprise_name, title, pain_point,
      expected_delivery, acceptance_criteria, grade, status, solvability_score, solvability_grade,
      commitment, agreement, is_free_brief, submitted_by, submitted_at, deleted_at)
    VALUES ('tp_1', 'ed_1', 'ent_1', '某银行', '零售风控助手', '人工审批慢', '可演示原型', '能跑', 'A',
      'approved', 11, 'A', '试点承诺', '试点承诺书', 0, 'u_a', '2026-10-01T00:00:00.000Z', NULL);
  `);
  const token = publicToken(s.db);
  const res = await call(s.app, 'GET', `/api/public/calendar.ics?editionId=ed_1&token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200, res.body);
  assert.equal(res.body.includes('某银行'), false, '企业名不公示');
  assert.equal(res.body.includes('零售风控助手'), false, '任务包标题不公示');
  cleanup(s.db, s.close, s.dataDir);
});

#!/usr/bin/env node
// scripts/preview-report.js — 打印预演库的**人话报告**（E181，2026-10-27）
//
// ⚠️ **这个脚本是给人看的**：它把 S-7~S-10 的四个就绪度闸跑一遍，
//    然后用**中文**把「哪些赛段达标、哪些没达标、为什么」讲清楚 ——
//    目的是让**评审**能判断「功能行为是否符合预期」，而不是看一堆数字。
//
// ⚠️ **它读的是临时库**（`data/preview/preview.db`，由 preview-seed.js 建）：
//    schema = 生产同款迁移；数据 = 预演数据集。
//    ⇒ 真实赛事数据到位后，把同样的表灌满，这个脚本**一个字都不用改**。
//
// 用法：
//   node scripts/preview-report.js
//   node scripts/preview-report.js --json       # 机器读（结构化）
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { getDefaultRules } from '../src/config.js';
import { readinessSummary } from '../src/services/readiness.js';
import { PREVIEW_SCENARIO } from '../db/preview/preview-dataset.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = join(here, '..');
const dbFile = join(platformDir, 'data', 'preview', 'preview.db');

const asJson = process.argv.includes('--json');

if (!existsSync(dbFile)) {
  console.error(`[preview-report] 临时库不存在：${dbFile}`);
  console.error('[preview-report] 先跑：node scripts/preview-seed.js');
  process.exit(2);
}

const rules = getDefaultRules();
const { db, close } = openDatabase({ dataDir: join(platformDir, 'data', 'preview'), filename: 'preview.db' });
try {
  const now = new Date().toISOString();
  const summary = readinessSummary({ db, editionId: 'pv-ed-1', rules, now });

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  const yesNo = (v) => (v === true ? '✅ 达标' : v === false ? '❌ 未达标' : '⚪ 不可判定');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  S-7 ~ S-10 业务就绪度 · 预演报告');
  console.log(`  临时库：${dbFile}`);
  console.log(`  锚点时刻：${now}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`【S-7 规模达标】${yesNo(summary.s7.met)}`);
  console.log(`   队伍数 ${summary.s7.teamCount} 支 / 门槛 ${summary.s7.thresholdTeams} 支`);
  console.log(`   注：${summary.s7.note}`);
  console.log('');

  console.log(`【S-8 评审无漏评】${yesNo(summary.s8.met)}`);
  console.log(`   赛段 ${summary.s8.stageCount} 个，其中可判定 ${summary.s8.measurableCount} 个`);
  for (const s of summary.s8.stages) {
    if (s.status === 'not_applicable') {
      console.log(`   · ${s.stageKey} ${s.stageName}：⚪ 不可判定 —— ${s.statusNote}`);
      continue;
    }
    const mark = s.complete ? '✅' : '❌';
    console.log(`   · ${s.stageKey} ${s.stageName}：${mark} 覆盖率 ${s.coveragePercent}%`
      + `（已交 ${s.submitted} / 应交 ${s.expected}，门槛 ${s.thresholdPercent}%）`
      + (s.missingCount ? `，漏评 ${s.missingCount} 格` : ''));
    if (s.overSubmitted) console.log('     ⚠️ ' + s.warnings.join(' / '));
  }
  console.log('');

  console.log(`【S-9 按时发榜】${yesNo(summary.s9.met)}`);
  console.log(`   时限 ${summary.s9.deadlineHours} 小时；超期 ${summary.s9.overdueCount} 个赛段`);
  for (const s of summary.s9.stages) {
    const mark = s.overdue ? '❌' : '✅';
    const delay = s.delayHours === null ? '—' : `${s.delayHours}h`;
    console.log(`   · ${s.stageKey} ${s.stageName}：${mark} 状态=${s.state} 延迟=${delay}`);
    console.log(`     ${s.note}`);
  }
  console.log('');

  console.log(`【S-10 闭环时效与产出】⚪ ${summary.s10.note}`);
  console.log('');

  console.log('── 场景矩阵对照（预演数据应当落在这五个分支上）──────────────');
  for (const [k, v] of Object.entries(PREVIEW_SCENARIO)) console.log(`   ${k}: ${v}`);
  console.log('');
  console.log('⚠️ 这些是**预演数据**，不是真实赛事数据 —— 用途是评审功能行为是否符合预期。');
  console.log('   真实数据到位后灌进同一套表（schema 不变）⇒ 闸的代码一行都不用改。');
} finally {
  close();
}

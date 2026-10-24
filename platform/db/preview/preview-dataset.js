// platform/db/preview/preview-dataset.js — 预演数据集（E181，2026-10-27）
//
// ⚠️ **这是「临时表」的数据侧**：预演数据装在一个**临时库**里，
//    库的 schema 由**生产同款迁移**建出来 ⇒ 表结构与生产**逐字一致**。
//    ⇒ 真实赛事数据到位后，**直接灌进同一套表** ⇒ services/readiness.js 的代码**一行都不用改**。
//    ⇒ ⛔ 本文件只提供**数据**；不许在这里出现任何「让闸更好通过」的特判。
//
// ⚠️ **为什么用相对日期而不是写死日期**：
//    写死的日期会随时间流逝而失效（今天「超期」的赛段，明天就变成「未到期」）。
//    ⇒ 所有时间都相对**锚点时刻**生成 ⇒ 无论什么时候跑预演，
//      五个赛段分别落在五个**分支**上（下面「场景矩阵」那一段就是验收标准）。
//
// ⚠️ **列名与生产表逐字一致**：本文件每一行都直接对应一张生产表的一行，
//    插入时按**表的名字**映射（见 scripts/preview-seed.js）⇒ 改列名会立刻插不进去（好事）。
//
// ── 场景矩阵（本文件的核心验收标准）────────────────────────────────
//   赛段 s1 调研   名册4队 席位3评委+1企业+1观察员 评分满格   → S-8 100% 达标 ｜ S-9 按时发榜（+24h）
//   赛段 s2 任务   同上但**故意漏 17 格**            → S-8 78.75% **不达标** ｜ S-9 超期发榜（+90h）
//   赛段 s3 开发   评分满格但**从未发榜**             → S-8 100% 达标 ｜ S-9 **never_published**
//   赛段 s4 路演   **没登记名册**（还没开打）        → S-8 **not_applicable** ｜ S-9 **no_roster**
//   赛段 s5 落地   尚未结束                          → S-8 部分评分（不给结论的重点段）｜ S-9 **not_due**
//
// ⚠️ **观察员（observer）不进应交格子**（R-JDG-11：观察员无投票权）
//    ⇒ s1 的应交 = 4 个有投票权席位 × 4 队 × 5 个评委席维度 = **80 格**。
//    ⚠️ **企业席（enterprise）有投票权** ⇒ 它**要打分**，且同样只打评委席维度。
//    ⚠️ **评委席维度**：初赛 5 个（track_fit / innovation / feasibility / completeness / collaboration）；
//    `enterprise` 维度走企业确认、`self` 维度走自评，**都不落在 stage_reviews**。

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const JUDGE_DIMS_INITIAL = ['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration'];
const JUDGE_DIMS_FINAL = ['innovation', 'feasibility', 'completeness', 'collaboration'];

const VOTING_SEATS = [
  { userId: 'pv-judge-1', seat: 'judge' },
  { userId: 'pv-judge-2', seat: 'judge' },
  { userId: 'pv-judge-3', seat: 'judge' },
  { userId: 'pv-ent-1', seat: 'enterprise' },
];
const OBSERVER = { userId: 'pv-obs-1', seat: 'observer' };

const TEAMS = ['pv-team-1', 'pv-team-2', 'pv-team-3', 'pv-team-4'];
const CAPTAINS = ['pv-cap-1', 'pv-cap-2', 'pv-cap-3', 'pv-cap-4'];

/**
 * s2 故意漏掉的 17 格（**刻意分组**，便于评审时看出「漏评长什么样」）：
 *   · judge-3 完全没评 team-4            → 5 格
 *   · judge-2 漏评 team-4 的 4 个维度      → 4 格
 *   · ent-1   漏评 team-3 的 4 个维度      → 4 格
 *   · judge-1 漏评 team-2 的 4 个维度      → 4 格
 *   合计 17 格 ⇒ 覆盖率 = (80-17)/80 = 78.75% < 90% ⇒ **不达标**
 */
const S2_MISSING = new Set([
  ...['track_fit', 'innovation', 'feasibility', 'completeness', 'collaboration']
    .map((d) => `pv-judge-3|pv-team-4|${d}`),
  ...['innovation', 'feasibility', 'completeness', 'collaboration']
    .map((d) => `pv-judge-2|pv-team-4|${d}`),
  ...['innovation', 'feasibility', 'completeness', 'collaboration']
    .map((d) => `pv-ent-1|pv-team-3|${d}`),
  ...['innovation', 'feasibility', 'completeness', 'collaboration']
    .map((d) => `pv-judge-1|pv-team-2|${d}`),
]);

function iso(anchorMs, offsetMs) {
  return new Date(anchorMs + offsetMs).toISOString();
}

/**
 * 生成一份完整的预演数据集。
 * @param {Date|string|number} [anchor] 锚点时刻（默认当前时间）
 * @returns {object} 按**表名**分组的行数组（列名与生产表逐字一致）
 */
export function buildPreviewDataset(anchor = new Date()) {
  const anchorMs = anchor instanceof Date ? anchor.getTime() : Date.parse(anchor);
  const nowIso = iso(anchorMs, 0);

  // ── editions ────────────────────────────────────────────────────
  const editions = [{
    id: 'pv-ed-1',
    name: '预演届期 · 华东区 AI 商业黑客松',
    city: '上海',
    starts_at: iso(anchorMs, -30 * DAY),
    ends_at: iso(anchorMs, 30 * DAY),
    created_at: iso(anchorMs, -30 * DAY),
  }];

  // ── cities ──────────────────────────────────────────────────────
  const cities = [{ id: 'pv-city-1', name: '上海', edition_id: 'pv-ed-1' }];

  // ── users ───────────────────────────────────────────────────────
  // ⚠️ phone 用**不可拨号的占位串**（不是 11 位数字）——
  //    既不会撞真实号码，也不会被敏感值扫描误判成「疑似真实手机号」。
  const mkUser = (id, name, extra = {}) => ({
    id,
    name,
    phone: `pv-${id}`,
    password_hash: 'preview-only-not-a-real-hash',
    mba_status: 'other',
    org: null,
    is_superadmin: 0,
    active: 1,
    created_at: iso(anchorMs, -30 * DAY),
    ...extra,
  });
  const users = [
    mkUser('pv-admin-1', '预演组委会', { is_superadmin: 1, org: '组委会' }),
    mkUser('pv-judge-1', '预演评委一', { org: '预演企业 A' }),
    mkUser('pv-judge-2', '预演评委二', { org: '预演企业 B' }),
    mkUser('pv-judge-3', '预演评委三', { org: '预演企业 C' }),
    mkUser('pv-ent-1', '预演企业席', { org: '预演企业 D' }),
    mkUser('pv-obs-1', '预演观察员', { org: '预演媒体' }),
    ...CAPTAINS.map((id, i) => mkUser(id, `预演队长${i + 1}`, { mba_status: 'mba' })),
  ];

  // ── task_packages ───────────────────────────────────────────────
  const taskPackages = CAPTAINS.map((capId, i) => ({
    id: `pv-tp-${i + 1}`,
    edition_id: 'pv-ed-1',
    enterprise_id: null,
    enterprise_name: `预演企业 ${String.fromCharCode(65 + i)}`,
    title: `预演任务卡 ${i + 1}`,
    pain_point: '预演痛点（占位）',
    expected_delivery: '预演交付物（占位）',
    acceptance_criteria: '预演验收标准（占位）',
    grade: 'A',
    status: 'approved',
    solvability_score: 3,
    solvability_grade: 'A',
    commitment: null,
    agreement: null,
    is_free_brief: 0,
    submitted_by: capId,
    submitted_at: iso(anchorMs, -29 * DAY),
    approved_by: 'pv-admin-1',
    approved_at: iso(anchorMs, -29 * DAY),
    meta_json: null,
    deleted_at: null,
  }));

  // ── teams ───────────────────────────────────────────────────────
  const teams = CAPTAINS.map((capId, i) => ({
    id: TEAMS[i],
    edition_id: 'pv-ed-1',
    name: `预演战队 ${i + 1}`,
    captain_id: capId,
    task_package_id: `pv-tp-${i + 1}`,
    tier: 'B',
    status: 'active',
    milestones_json: null,
    created_at: iso(anchorMs, -28 * DAY),
    deleted_at: null,
  }));

  // ── stages ──────────────────────────────────────────────────────
  // ⛔ 赛段时间全部相对锚点（见文件头「为什么用相对日期」）
  // ⚠️ `roster` 是**预演专用标记**（这段开没开打），**不进生产表** ⇒ 单独留在 specs 里，
  //    不能混进 stages 行（stageReviews / stageJudges / stage_team 都要按它分支）。
  const stageSpecs = [
    {
      id: 'pv-stg-s1', key: 's1', name: '调研', kind: 'initial',
      starts_at: iso(anchorMs, -14 * DAY), ends_at: iso(anchorMs, -10 * DAY),
      scoring_config_key: 'initial', roster: true,
    },
    {
      id: 'pv-stg-s2', key: 's2', name: '任务', kind: 'initial',
      starts_at: iso(anchorMs, -9 * DAY), ends_at: iso(anchorMs, -6 * DAY),
      scoring_config_key: 'initial', roster: true,
    },
    {
      id: 'pv-stg-s3', key: 's3', name: '开发', kind: 'initial',
      starts_at: iso(anchorMs, -5 * DAY), ends_at: iso(anchorMs, -3 * DAY),
      scoring_config_key: 'initial', roster: true,
    },
    {
      id: 'pv-stg-s4', key: 's4', name: '路演', kind: 'final',
      starts_at: iso(anchorMs, -2 * DAY), ends_at: iso(anchorMs, -1 * DAY),
      scoring_config_key: 'final', roster: false,
    },
    {
      id: 'pv-stg-s5', key: 's5', name: '落地', kind: 'final',
      starts_at: iso(anchorMs, 1 * DAY), ends_at: iso(anchorMs, 10 * DAY),
      scoring_config_key: 'final', roster: true,
    },
  ];
  const stages = stageSpecs.map((s) => ({
    id: s.id,
    edition_id: 'pv-ed-1',
    key: s.key,
    name: s.name,
    kind: s.kind,
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    freeze_at: null,
    scoring_config_key: s.scoring_config_key,
    status: 'open',
  }));

  // ── stage_judges / stage_team ───────────────────────────────────
  const stageJudges = [];
  const stageTeam = [];
  for (const s of stageSpecs) {
    if (!s.roster) continue; // s4：没登记名册 ⇒ 也没派评委（这段还没开打）
    for (const seat of [...VOTING_SEATS, OBSERVER]) {
      stageJudges.push({
        stage_id: s.id,
        user_id: seat.userId,
        seat: seat.seat,
        scope_type: 'edition',
        scope_id: 'pv-ed-1',
        assigned_at: iso(anchorMs, -15 * DAY),
        conflict_declared_at: iso(anchorMs, -15 * DAY),
        conflict_declaration_id: null,
      });
    }
    for (const teamId of TEAMS) {
      stageTeam.push({
        id: `pv-st-${s.key}-${teamId}`,
        stage_id: s.id,
        team_id: teamId,
        registered_at: iso(anchorMs, -15 * DAY),
      });
    }
  }

  // ── stage_reviews ───────────────────────────────────────────────
  const stageReviews = [];
  let revSeq = 0;
  for (const s of stageSpecs) {
    if (!s.roster) continue;
    const dims = s.scoring_config_key === 'initial' ? JUDGE_DIMS_INITIAL : JUDGE_DIMS_FINAL;
    // s5 尚未结束 ⇒ 只给部分评分（评审时能看到「未结束段落的部分数据」长什么样）
    const partial = s.key === 's5';
    for (const seat of VOTING_SEATS) {
      for (const teamId of TEAMS) {
        for (const dim of dims) {
          const cellKey = `${seat.userId}|${teamId}|${dim}`;
          if (s.key === 's2' && S2_MISSING.has(cellKey)) continue; // 故意漏评
          if (partial && (dim === 'collaboration' || (seat.userId === 'pv-ent-1' && dim === 'feasibility'))) continue;
          revSeq += 1;
          stageReviews.push({
            id: `pv-rev-${String(revSeq).padStart(4, '0')}`,
            stage_id: s.id,
            judge_id: seat.userId,
            team_id: teamId,
            dimension: dim,
            raw_score: 60 + ((revSeq * 7) % 35),
            submitted_at: iso(anchorMs, -12 * DAY),
            request_id: null,
            calibrated: 0,
            deleted_at: null,
          });
        }
      }
    }
  }

  // ── leaderboard_snapshots（发榜时刻）────────────────────────────
  // 一次发榜写 3 个 scope（services/leaderboard.js 的 SCOPES = rank/business/personal），
  // 它们 created_at 相同 ⇒ 取最早的一条即发榜时刻。
  const leaderboardSnapshots = [];
  const snap = (stageId, atIso, seq) => {
    for (const scope of ['rank', 'business', 'personal']) {
      leaderboardSnapshots.push({
        id: `pv-snap-${stageId}-${scope}`,
        edition_id: 'pv-ed-1',
        stage_id: stageId,
        scope,
        payload_json: JSON.stringify({ preview: true, scope }),
        created_at: atIso,
      });
      seq += 1;
    }
    return seq;
  };
  // s1：结束 +24h 发榜 ⇒ 按时（时限 72h）
  snap('pv-stg-s1', iso(anchorMs, -10 * DAY + 24 * HOUR), 0);
  // s2：结束 +90h 发榜 ⇒ 超期（时限 72h）
  snap('pv-stg-s2', iso(anchorMs, -6 * DAY + 90 * HOUR), 3);
  // s3：**不发** ⇒ never_published
  // s4 / s5：也不发

  return {
    editions,
    cities,
    users,
    task_packages: taskPackages,
    teams,
    stages,
    stage_judges: stageJudges,
    stage_team: stageTeam,
    stage_reviews: stageReviews,
    leaderboard_snapshots: leaderboardSnapshots,
    _meta: {
      anchor: nowIso,
      note: '预演数据集 —— 装在临时库里（生产同款迁移建的 schema）⇒ 真实数据可直接灌进同一套表',
      expectedCells: { s1: 80, s2: 80, s3: 80, s5: 64 },
    },
  };
}

export const PREVIEW_SCENARIO = {
  s1: '名册4队·席位4有投票权+1观察员·评分满格 ⇒ S-8 100% 达标；结束+24h发榜 ⇒ S-9 按时',
  s2: '同 s1 但故意漏 17 格 ⇒ S-8 78.75% 不达标；结束+90h发榜 ⇒ S-9 超期',
  s3: '评分满格但从未发榜 ⇒ S-8 达标；S-9 never_published',
  s4: '没登记名册（还没开打）⇒ S-8 not_applicable；S-9 no_roster',
  s5: '尚未结束 ⇒ S-9 not_due；S-8 只给了部分评分',
};

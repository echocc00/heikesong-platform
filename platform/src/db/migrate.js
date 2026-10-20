// src/db/migrate.js — 迁移机制
// 依据：设计文档 §14.2。迁移只向前，不回滚；用 schema_migrations 表记录版本。
//   ⛔ 不赌原生 ALTER TABLE 的能力边界（node:sqlite 捆绑的 SQLite 版本未核实），
//      一律"新表 + 迁移"，expand-contract 三步走。
//   ⛔ 版本号重复 → **响亮抛错**，绝不静默跳过。
//      依据：全局约束「配置校验 fail-fast：权重合计≠100% / 阈值不单调 → 拒绝启动并报错」。
//      同一类缺陷在迁移层的表现是"两个文件抢同一个版本号"：若静默跳过，
//      先跑通的那个版本会把后一个永久遮蔽 —— schema 缺口被固化，
//      而运维看到的是"迁移完成 / 本次无新迁移"、退出码 0，看不出任何异常。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`;

// 版本号在文件名里的原始写法（保留前导零），仅用于错误信息展示
function versionLabel(name) {
  return name.split('_')[0];
}

export function readMigrationFiles(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => {
      // 严格解析：文件名必须形如 <版本号>_<名称>.sql。
      // ⛔ 不能用 Number(name.split('_')[0])：那样 '_init.sql'（Number('')===0）、
      //    '1e3_x.sql'（Number('1e3')===1000）会被静默当成合法版本号 ——
      //    在「全局唯一序位」（001=P0、002=P1 … 006=P5）上开出一个静默缺口。
      //    依据：docs/superpowers/plans/INTERFACES.md「迁移版本号是全局唯一序位，
      //    002 起依次是 P1→P5」；同文档的重复版本号检查也以 '_' 为分隔符
      //    （ls -1 *.sql | cut -d_ -f1 | sort | uniq -d）。
      const m = /^(\d+)_(.+)\.sql$/.exec(name);
      if (!m) {
        throw new Error(`迁移文件名必须形如 <版本号>_<名称>.sql: ${name}`);
      }
      const version = Number(m[1]);
      // 版本号从 001 起 —— 0 不是合法序位（001=P0 … 006=P5）。
      if (version < 1) {
        throw new Error(`迁移版本号必须从 001 起: ${name}`);
      }
      return { version, name, sql: readFileSync(join(dir, name), 'utf8') };
    })
    // 排序：版本号升序 + 同版本号按文件名字节序。
    // ⚠️ readdirSync 的返回顺序在 POSIX 里未定义：APFS 按名序、ext4/xfs 按 hash 序，
    //    只按 version 排序会让同版本号的两个文件谁在前**因平台而异** →
    //    跨平台不一致（R-OPS-02）。
    //    比较用字节序（< / >），**不用 localeCompare**：后者依赖 locale，跨平台不一致。
    //    依据：R-OPS-02「跨平台稳定」。
    .sort((a, b) => (a.version - b.version) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // 重复版本号 → 抛错。必须在任何迁移 SQL 落地**之前**发现，
  // 否则先落地的那张表会把后一个永久遮蔽（静默跳过 = schema 缺口被固化）。
  const seen = new Map();
  for (const f of files) {
    const prev = seen.get(f.version);
    if (prev) {
      // 两个文件名**显式**按字节序排好再拼进错误信息 ——
      // 这样即使上面的排序被改回去，错误信息本身仍然确定（不依赖 readdir 顺序）。
      // 跨平台保证由**构造**成立，而不是靠"恰好 readdir 有序"。
      const [x, y] = prev.name < f.name ? [prev.name, f.name] : [f.name, prev.name];
      throw new Error(
        `迁移版本号重复: ${versionLabel(x)} (${x}, ${y})`,
      );
    }
    seen.set(f.version, f);
  }

  return files;
}

export function applyMigrations(db, migrationsDir) {
  // 先读文件并校验：重复版本号 / 文件名格式错误必须在任何 SQL 执行前失败
  const files = readMigrationFiles(migrationsDir);

  db.exec(MIGRATION_TABLE);
  // 已应用版本 → 当初应用时的文件名（用于校验迁移文件有没有被改名/挪位）
  const appliedMap = new Map(
    db.prepare('SELECT version, name FROM schema_migrations').all().map((r) => [r.version, r.name]),
  );

  const applied = [];
  for (const m of files) {
    const recordedName = appliedMap.get(m.version);
    if (recordedName !== undefined) {
      // 已应用过：文件名必须与当初一致。
      // 被改名/挪位 → 抛错，而不是"跳过"（跳过会让迁移历史与文件对不上账）。
      if (recordedName !== m.name) {
        throw new Error(
          `迁移 ${versionLabel(m.name)} 已以 ${recordedName} 应用，当前文件名为 ${m.name}；迁移文件名不可变更`,
        );
      }
      continue;
    }
    // 单事务内串行执行：要么全成功，要么全不成功
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      applied.push(m.name);
      // 防御性纵深：循环内登记已应用版本，
      // 不让"同一版本被应用两次"这类问题依赖循环外的快照。
      appliedMap.set(m.version, m.name);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${m.name} 失败: ${err.message}`);
    }
  }

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return { applied, version: row?.v ?? 0 };
}

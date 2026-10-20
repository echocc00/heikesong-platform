# AI 商业黑客松赛事平台

零依赖 Node 单体。`git clone` 后不需要 `npm install`，直接：

```bash
node scripts/migrate.js   # 建库 + 迁移
node scripts/seed.js      # 种子数据（可选）
node src/server.js        # http://127.0.0.1:8080
node --test               # 跑测试
```

## 运行环境

- **Node ≥ 22.16.0**。这个下限是**两个下限的并集** = max(22.13.0, 22.16.0)：

  | 下限 | 原因 | 出处 |
  |---|---|---|
  | 22.13.0 | `node:sqlite` 免 `--experimental-sqlite` 标志。22.5.0–22.12.x 上 import 直接抛错，而本项目四个 scripts 都不带该标志 | Node v22 文档 SQLite 页 History 表 |
  | 22.16.0 | `sqlite.backup()` —— §14 备份方案依赖它（P6 阶段的备份/恢复脚本就是它） | 同上，`sqlite.backup` 条目 `Added in: v22.16.0` |

  来源：<https://nodejs.org/docs/latest-v22.x/api/sqlite.html>
  官方原文：`v22.5.0 Added in: v22.5.0` / `v22.13.0 SQLite is no longer behind --experimental-sqlite but still experimental.` / `sqlite.backup(sourceDb, destination[, options])` — `Added in: v22.16.0`。详见设计文档 §4.2「运行时与依赖」。

  `package.json` 的 `engines` 是**项目级单一声明**，表达的是整个系统的运行时下限，不是 P0 此刻用到的下限。因此 P0 实际只用得到 22.13.0，`>=22.16.0` 是**保守声明**：它不会拒掉任何能跑的 Node，只是提前挡掉 22.13–22.15（这三个小版本早已无人使用，22.16.0 发布于 2025-02）。**声明一个跑不起来的版本比声明一个略严的版本更糟** —— 前者让用户以为装完就能用、装了才炸。

- **`node:sqlite` 在 Node 22.x 仍是 experimental（Stability 1.1 - Active development）**。package.json 的四个 scripts 用 `--disable-warning=ExperimentalWarning` **按告警类型整体屏蔽**这条告警 —— 不是逐条压制，也不掩盖真实错误。直接用 `node` 手动跑而不走 npm scripts 时，该告警会重新出现，属预期。

- 生产仍推荐 **Node 24**；本项目**不使用任何 Node-24-only API**（Node 22 没有 `URLPattern` → 路由手写，不因此抬高运行时门槛）。

- **`engines` 在 npm 里默认只是建议性的** —— 版本不满足时只会打印 `EBADENGINE` 警告，除非 `.npmrc` 里设了 `engine-strict=true` 才会阻断安装。本项目零依赖、不走 `npm install`，因此这个下限是**自检性质**的：跑不动时会在 import `node:sqlite` 处直接报错，而不是装的时候被拦住。

## 硬约束

- **npm 依赖 0 个**。只用 Node 标准库。`test/zero-deps.test.js` 会守住这条。
- **规则不写死在代码里**。可变规则全在 `rules/*.json`，改 JSON 即改规则。
- **配置校验 fail-fast**。权重合计不等于 100% 就拒绝启动，不静默降级。
- **行为分不进总分**。总分函数的签名里就没有行为分参数。
- **两种"企业签字"是两张表**。`enterprise_confirmations`（主观评分，进总分）/ `milestone_signoffs`（客观事实，不进总分）。
- **可见性在 API 层过滤**。前端拿不到无权数据。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | 监听端口 |
| `DATA_DIR` | `./data` | 数据库与上传目录 |
| `SESSION_TTL_DAYS` | 7 | 会话有效期 |

## 设计文档

`../docs/superpowers/specs/2026-10-20-heikesong-platform-design.md`

# AI 商业黑客松赛事平台

零依赖 Node 单体赛事平台：报名与组队 → 评审打分 → 积分段位与公开榜 → 审计反作弊 → 池化协同 → 部署与演示站。

> `git clone` 后**不需要 `npm install`**，直接跑。

```bash
cd platform
node scripts/migrate.js   # 建库 + 迁移
node scripts/seed.js      # 种子数据（可选）
node src/server.js        # http://127.0.0.1:8080
node --test               # 跑测试
```

**运行环境**：Node ≥ 22.16.0（`node:sqlite` 免实验标志 + `sqlite.backup()`，两者下限的并集）。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `platform/src/` | 服务端实现：领域层（`domain/`）、HTTP 路由（`http/routes/`）、数据访问（`db/`）、审计反作弊（`audit/`）、鉴权（`auth/`） |
| `platform/rules/` | 赛制规则配置（评分、积分、段位、行为分、合规、赛程、池化等 JSON），改配置即生效，不改代码 |
| `platform/db/migrations/` | 数据库迁移 |
| `platform/test/` | 测试套件（1277 例） |
| `platform/web/` | 前端：SPA + 演示站构建产物（`dist/`，构建产物不入库） |
| `platform/deploy/` | 部署资产：nginx、systemd、docker-compose、一键安装脚本 |
| `docs/` | 需求溯源、规则冲突登记、组委会确认清单、部署运维手册、设计与实施计划 |

## 常用命令

全部在 `platform/` 下执行。

| 命令 | 作用 |
| --- | --- |
| `node --test` | 跑测试套件 |
| `node scripts/migrate.js` | 建库 / 执行迁移 |
| `node scripts/seed.js` | 写入种子数据 |
| `node scripts/backup.js` | 备份数据库 |
| `node scripts/restore.js` | 从备份恢复 |
| `node scripts/build-demo.js` | 构建公开演示站（产物 → `platform/web/dist/`） |
| `node scripts/serve-demo.js` | 本地预览演示站 |
| `node scripts/audit-scan.js` | 禁用词 / 证据链扫描闸 |

## 架构要点

- **零第三方依赖**：仅用 Node 标准库，克隆即可运行，不需要安装步骤。
- **规则配置化**：赛制口径集中在 `platform/rules/*.json`，改一份 JSON 即生效。
- **单写者约束**：SQLite 只允许单写进程，写入串行化；扩容只能加「读」（静态资源交给 nginx 直出）。
- **双签 / 归一化 / 段位 / 滚动榜 / 匿名 / 回避**：这些机制全行业无现成实现，均自建。

## 文档

- 设计文档：`docs/superpowers/specs/2026-10-20-heikesong-platform-design.md`
- 需求落地表：`docs/requirement-implementation-map.md`
- 规则冲突登记：`docs/rule-decisions.md`
- 组委会确认清单：``
- 部署运维手册：`docs/deployment.md`

## 许可

见 [LICENSE](LICENSE)。

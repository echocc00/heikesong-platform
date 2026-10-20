# AI 商业黑客松赛事平台

零依赖 Node 单体。`git clone` 后不需要 `npm install`，直接：

```bash
node scripts/migrate.js   # 建库 + 迁移
node scripts/seed.js      # 种子数据（可选）
node src/server.js        # http://127.0.0.1:8080
node --test               # 跑测试
```

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

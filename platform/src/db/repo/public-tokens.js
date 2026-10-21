// src/db/repo/public-tokens.js — 公开访问令牌仓储
// 依据：INTERFACES.md §6 `public_tokens(token, scope, edition_id, expires_at, created_at)`
// ⛔ token 列存 SHA-256 十六进制（与 P0 的 sessions.token_hash 同一纪律）：
//    库被拖走也拿不到可用的公开令牌。明文只在签发时返回一次。
export function insertPublicToken(db, { token, scope, editionId, expiresAt, now }) {
  db.prepare(
    'INSERT INTO public_tokens (token, scope, edition_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(token, scope, editionId, expiresAt, now);
  return { token, scope, editionId, expiresAt };
}

export function findPublicToken(db, tokenHash) {
  return db.prepare('SELECT * FROM public_tokens WHERE token = ?').get(tokenHash) ?? null;
}

export function deletePublicToken(db, tokenHash) {
  return db.prepare('DELETE FROM public_tokens WHERE token = ?').run(tokenHash).changes;
}

export function listPublicTokens(db, { editionId = null } = {}) {
  return editionId
    ? db.prepare('SELECT * FROM public_tokens WHERE edition_id = ? ORDER BY created_at, token').all(editionId)
    : db.prepare('SELECT * FROM public_tokens ORDER BY created_at, token').all();
}

// src/http/routes/pools.js — 三池只读 API + 同步
// 依据：INTERFACES.md §6 的 P5 API 清单；R-POOL-01/02/03/04
// ⚠️ 一期【不做三池前台页面】（设计文档 §1.2）：这里只提供只读 API 与同步入口。
import { appError } from '../../errors.js';
import { can } from '../../auth/permissions.js';
import {
  syncPoolProjects, syncPoolTalents, syncPoolResources,
  listPoolProjects, listPoolTalents, listPoolResources,
} from '../../services/pools.js';

export function registerPoolsRoutes(router, { db, rules }) {
  router.add('GET', '/api/pools/projects', async ({ user, query }) => ({
    projects: listPoolProjects({
      db,
      filter: { editionId: query.editionId, limit: Number(query.limit) || undefined },
      viewer: user,
    }),
  }));

  router.add('GET', '/api/pools/talents', async ({ user, query }) => ({
    talents: listPoolTalents({
      db,
      filter: {
        editionId: query.editionId,
        userId: query.userId,
        minPoints: query.minPoints !== undefined ? Number(query.minPoints) : undefined,
        limit: Number(query.limit) || undefined,
      },
      viewer: user,
    }),
  }));

  router.add('GET', '/api/pools/resources', async ({ user, query }) => ({
    resources: listPoolResources({
      db,
      filter: {
        editionId: query.editionId,
        enterpriseId: query.enterpriseId,
        kind: query.kind,
        limit: Number(query.limit) || undefined,
      },
      viewer: user,
    }),
  }));

  router.add('POST', '/api/pools/sync', async ({ user, body, query }) => {
    if (!user) throw appError(401, 'UNAUTHENTICATED', '未登录');
    const editionId = body?.editionId ?? query.editionId;
    if (!editionId) throw appError(400, 'EDITION_REQUIRED', 'editionId 必填');
    if (!can(user, 'pool:write', { scopeType: 'edition', scopeId: editionId }, db)) {
      throw appError(403, 'FORBIDDEN', '没有三池维护权限');
    }
    return {
      projects: syncPoolProjects({ db, editionId, rules }),
      talents: syncPoolTalents({ db, editionId, rules }),
      resources: syncPoolResources({ db, editionId, rules }),
    };
  });
}

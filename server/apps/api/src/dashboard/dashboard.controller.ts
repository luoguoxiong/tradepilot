import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { resolveScope, type OrgScopeContext } from '@tradepilot/db';
import { DashboardService } from './dashboard.service.js';
import { dashboardQuerySchema, type DashboardQuery } from './dashboard.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 01 Dashboard 工作台接口（接口 01 §2 / §3.1，M5-D2）：
 * GET /dashboard/summary 首屏聚合（只读）。
 * P0 降级（00 §5.1 D1~D3）：kpis 仅 new_customers/new_inquiries、
 * pendingItems 仅 customer_reply/high_value_overdue、dailyReport 不返回。
 * scope 经 query 传入（缺省取角色上限，接口总览 §4.4），sales=self 只聚合自己客户。
 */
@Controller('dashboard')
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  /** 01 §3.1 首屏聚合（greeting/kpis/aiEmployees/highValueCustomers/pendingItems） */
  @Get('summary')
  async summary(
    @Query(new ZodValidationPipe(dashboardQuerySchema)) query: DashboardQuery,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.dashboard.summary(this.ctx(req, query.scope), query);
  }

  /** 资源级访问取角色上限（sales=self / manager=team / admin=all；query scope 显式传入时校验并收窄） */
  private ctx(
    req: Request & { authUser?: AccessTokenPayload },
    scope?: 'self' | 'team' | 'all',
  ): OrgScopeContext {
    const user = this.requireUser(req);
    return {
      orgId: user.orgId,
      userId: user.sub,
      role: user.role,
      scope: resolveScope(user.role, scope),
    };
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new Error('未认证（JwtAuthGuard 缺失）');
    }
    return user;
  }
}

import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { resolveScope, type OrgScopeContext } from '@tradepilot/db';
import { DashboardService } from './dashboard.service.js';
import {
  dashboardQuerySchema,
  generateDailyReportSchema,
  type DashboardQuery,
  type GenerateDailyReportDto,
} from './dashboard.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 01 Dashboard 工作台接口（接口 01 §2 / §3.1~§3.3，M5-D2）：
 * GET /dashboard/summary 首屏聚合、GET /dashboard/daily-report（§3.2）、
 * POST /dashboard/daily-report/generate（§3.3）。
 * D1/D2 随 09/10 交付恢复全量 metric / 待处理类型；D3 随 13 恢复每日报告（经营报告为经理视角，仅 admin/manager）。
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

  /** 01 §3.2 最新 AI 每日报告（无报告 → 40401；经理视角，与 13 权限一致） */
  @Get('daily-report')
  @Roles('admin', 'manager')
  async dailyReport(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.dashboard.dailyReport(this.ctx(req));
  }

  /** 01 §3.3 触发生成 AI 每日报告（异步任务，复用 13 经营分析） */
  @Post('daily-report/generate')
  @Roles('admin', 'manager')
  async generateDailyReport(
    @Body(new ZodValidationPipe(generateDailyReportSchema)) body: GenerateDailyReportDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.dashboard.generateDailyReport(this.ctx(req), body);
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

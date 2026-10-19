/**
 * 13 AI 外贸经理接口（页面级字段与接口文档 13 §2/§3，P1-13）：
 * GET /manager/overview|discoveries|team-efficiency|reports|reports/{id}
 * POST /manager/discoveries/{id}/execute、/manager/reports/generate
 * 权限：经理及以上（13 §4 经理视角全量经营数据；sales 40301）。
 */
import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { resolveScope, type OrgScopeContext, type Scope } from '@tradepilot/db';
import type { AccessTokenPayload } from '../auth/token.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  generateReportSchema,
  listReportsQuerySchema,
  managerDiscoveriesQuerySchema,
  managerOverviewQuerySchema,
  type GenerateReportDto,
  type ListReportsQuery,
  type ManagerDiscoveriesQuery,
  type ManagerOverviewQuery,
} from './manager.dto.js';
import { ManagerService } from './manager.service.js';

@Controller('manager')
@Roles('admin', 'manager')
export class ManagerController {
  constructor(@Inject(ManagerService) private readonly manager: ManagerService) {}

  /** 13 §3.1 今日经营概览（date 缺省今天） */
  @Get('overview')
  async overview(
    @Query(new ZodValidationPipe(managerOverviewQuerySchema)) query: ManagerOverviewQuery,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.manager.overview(this.ctx(req, query), query);
  }

  /** 13 §3.2 AI 发现列表（机会 + 风险；实时重算并幂等落库） */
  @Get('discoveries')
  async discoveries(
    @Query(new ZodValidationPipe(managerDiscoveriesQuerySchema)) query: ManagerDiscoveriesQuery,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.manager.discoveries(this.ctx(req, query), query);
  }

  /** 13 §3.3 一键执行建议（发起类动作白名单，外发仍走审批） */
  @Post('discoveries/:id/execute')
  async execute(@Param('id') id: string, @Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.manager.execute(this.ctx(req), id);
  }

  /** 13 §1.3 AI 团队效率（与 02 员工卡片同源） */
  @Get('team-efficiency')
  async teamEfficiency(
    @Query(new ZodValidationPipe(managerOverviewQuerySchema)) query: ManagerOverviewQuery,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.manager.teamEfficiency(this.ctx(req, query));
  }

  /** 13 §3.4 生成经营报告（异步任务，返回 taskId + reportId） */
  @Post('reports/generate')
  async generateReport(
    @Body(new ZodValidationPipe(generateReportSchema)) body: GenerateReportDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.manager.generateReport(this.ctx(req), body);
  }

  /** 13 §1.4 报告列表 */
  @Get('reports')
  async listReports(
    @Query(new ZodValidationPipe(listReportsQuerySchema)) query: ListReportsQuery,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.manager.listReports(this.ctx(req, query), query);
  }

  /** 13 §1.4 报告详情（五段 Markdown + citations） */
  @Get('reports/:id')
  async getReport(
    @Param('id') id: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.manager.getReport(this.ctx(req), id);
  }

  private ctx(
    req: Request & { authUser?: AccessTokenPayload },
    query?: { scope?: Scope },
  ): OrgScopeContext {
    const user = this.requireUser(req);
    return {
      orgId: user.orgId,
      userId: user.sub,
      role: user.role,
      scope: resolveScope(user.role, query?.scope),
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

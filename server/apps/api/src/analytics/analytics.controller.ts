import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { resolveScope, type OrgScopeContext, type Scope } from '@tradepilot/db';
import type { AccessTokenPayload } from '../auth/token.service.js';
import { RawResponse } from '../common/decorators/raw-response.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  analyticsFilterSchema,
  drilldownQuerySchema,
  type AnalyticsFilterDto,
  type DrilldownQueryDto,
} from './analytics.dto.js';
import { AnalyticsService } from './analytics.service.js';

/**
 * 数据中心接口（接口 15 §3，P1-15-01~06）：
 * GET /analytics/customer-trend|market-distribution|ai-contribution|drilldown|export。
 * 数据权限：query.scope（self/team/all）经 resolveScope 收敛到角色上限（00 §4.4）。
 */
@Controller('analytics')
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  /** 15 §3.1 客户增长趋势（按当地日聚合新客户/新询盘/新报价） */
  @Get('customer-trend')
  async customerTrend(
    @Query(new ZodValidationPipe(analyticsFilterSchema)) query: AnalyticsFilterDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.analytics.customerTrend(this.ctx(req, query), query);
  }

  /** 15 §3.2 市场分布（Top3 国家 + OTHER 占比） */
  @Get('market-distribution')
  async marketDistribution(
    @Query(new ZodValidationPipe(analyticsFilterSchema)) query: AnalyticsFilterDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.analytics.marketDistribution(this.ctx(req, query), query);
  }

  /** 15 §3.3 AI 贡献（含 caliberNote 估算口径说明） */
  @Get('ai-contribution')
  async aiContribution(
    @Query(new ZodValidationPipe(analyticsFilterSchema)) query: AnalyticsFilterDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.analytics.aiContribution(this.ctx(req, query), query);
  }

  /** 15 §3.4 指标下钻明细（metric 白名单 + 分页，单页 ≤100 条） */
  @Get('drilldown')
  async drilldown(
    @Query(new ZodValidationPipe(drilldownQuerySchema)) query: DrilldownQueryDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.analytics.drilldown(this.ctx(req, query), query);
  }

  /** 15 §3.5 导出当前筛选下的趋势/分布/贡献（XLSX 附件下载） */
  @Get('export')
  @RawResponse()
  async export(
    @Query(new ZodValidationPipe(analyticsFilterSchema)) query: AnalyticsFilterDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
    @Res() res: Response,
  ): Promise<void> {
    const { filename, buffer } = await this.analytics.exportExcel(this.ctx(req, query), query);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  private ctx(
    req: Request & { authUser?: AccessTokenPayload },
    query: { scope?: Scope },
  ): OrgScopeContext {
    const user = this.requireUser(req);
    return {
      orgId: user.orgId,
      userId: user.sub,
      role: user.role,
      scope: resolveScope(user.role, query.scope),
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

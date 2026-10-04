/**
 * Apollo 相似客户获客接口（四步工作流）：
 * - GET  /apollo-acquisition/seed-profile?customerId=   种子画像（步骤①）
 * - POST /apollo-acquisition/keywords                   LLM 拆解 → 搜索参数（步骤②）
 * - POST /apollo-acquisition/runs/:id/search            Apollo 公司+联系人检索（步骤③）
 * - POST /apollo-acquisition/runs/:id/analyze           AI 复筛 → 落 ai_lead（步骤④）
 * - GET  /apollo-acquisition/runs、/runs/:id            轮次列表/详情
 */
import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { resolveScope, type OrgScopeContext } from '@tradepilot/db';
import { ApolloAcquisitionService } from './apollo-acquisition.service.js';
import {
  apolloAnalyzeSchema,
  apolloSearchSchema,
  generateKeywordsSchema,
  listApolloRunsQuerySchema,
  seedProfileQuerySchema,
  type ApolloAnalyzeDto,
  type ApolloSearchDto,
  type GenerateKeywordsDto,
  type ListApolloRunsQuery,
  type SeedProfileQuery,
} from './apollo-acquisition.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

@Controller()
export class ApolloAcquisitionController {
  constructor(
    @Inject(ApolloAcquisitionService) private readonly apollo: ApolloAcquisitionService,
  ) {}

  /** 步骤① 种子客户画像 */
  @Get('apollo-acquisition/seed-profile')
  async seedProfile(
    @Query(new ZodValidationPipe(seedProfileQuerySchema)) query: SeedProfileQuery,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.apollo.getSeedProfile(this.ctx(req), query.customerId);
  }

  /** 步骤② LLM 拆解种子画像 → Apollo 搜索参数（建 run） */
  @Post('apollo-acquisition/keywords')
  async keywords(
    @Body(new ZodValidationPipe(generateKeywordsSchema)) dto: GenerateKeywordsDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.apollo.generateKeywords(this.ctx(req), dto);
  }

  /** 步骤③ Apollo 检索（公司 + 联系人） */
  @Post('apollo-acquisition/runs/:id/search')
  async search(
    @Param('id') runId: string,
    @Body(new ZodValidationPipe(apolloSearchSchema)) dto: ApolloSearchDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.apollo.search(this.ctx(req), runId, dto);
  }

  /** 步骤④ AI 二次复筛 → 符合条件落 ai_lead 发现池 */
  @Post('apollo-acquisition/runs/:id/analyze')
  async analyze(
    @Param('id') runId: string,
    @Body(new ZodValidationPipe(apolloAnalyzeSchema)) dto: ApolloAnalyzeDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.apollo.analyze(this.ctx(req), runId, dto);
  }

  /** 轮次列表 */
  @Get('apollo-acquisition/runs')
  async listRuns(
    @Query(new ZodValidationPipe(listApolloRunsQuerySchema)) query: ListApolloRunsQuery,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.apollo.listRuns(this.ctx(req), query);
  }

  /** 轮次详情（含搜索参数/原始结果/复筛结论） */
  @Get('apollo-acquisition/runs/:id')
  async getRun(
    @Param('id') runId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.apollo.getRun(this.ctx(req), runId);
  }

  private ctx(req: Request & { authUser?: AccessTokenPayload }): OrgScopeContext {
    const user = this.requireUser(req);
    return { orgId: user.orgId, userId: user.sub, role: user.role, scope: resolveScope(user.role) };
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) throw new Error('未认证（JwtAuthGuard 缺失）');
    return user;
  }
}

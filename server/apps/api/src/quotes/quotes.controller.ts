import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { paginationQuerySchema } from '@tradepilot/shared';
import { QuotesService } from './quotes.service.js';
import {
  aiPricingRequestSchema,
  createQuoteSchema,
  listQuotesQuerySchema,
  markLostSchema,
  updateQuoteSchema,
  type AiPricingRequestDto,
  type CreateQuoteDto,
  type ListQuotesQuery,
  type MarkLostDto,
  type UpdateQuoteDto,
} from './quotes.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { RawResponse } from '../common/decorators/raw-response.decorator.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 报价中心接口（接口 09 §2/§3，P1）：
 * GET/POST /quotes、GET/PUT /quotes/{id}、GET /quotes/summary、
 * POST /quotes/{id}/ai-pricing|submit|send|mark-won|mark-lost|revive、
 * GET /quotes/{id}/negotiation-ladder|pdf。
 * 状态机：draft → waiting_approval → sent → won；draft/waiting_approval/sent → lost；lost → draft。
 */
@Controller('quotes')
export class QuotesController {
  constructor(@Inject(QuotesService) private readonly quotes: QuotesService) {}

  /** 09 §1.1/§2 报价列表（status Tab + keyword=报价编号/客户名，分页；附各档数量） */
  @Get()
  async list(
    @Query(new ZodValidationPipe(listQuotesQuerySchema.merge(paginationQuerySchema)))
    query: ListQuotesQuery & { page: number; pageSize: number; keyword?: string },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.quotes.list(this.requireUser(req).orgId, query);
  }

  /** 09 §1.1 各档 Tab 数量（all + 五状态） */
  @Get('summary')
  async summary(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.quotes.summary(this.requireUser(req).orgId);
  }

  /** 09 §3.1 新建报价（响应 { quoteId, quoteNo, status }；MOQ/有效期/利润红线校验） */
  @Post()
  async create(
    @Body(new ZodValidationPipe(createQuoteSchema)) dto: CreateQuoteDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.quotes.create(user.orgId, user.sub, dto);
  }

  /** 09 §1.2/§1.3 报价详情（报价头 + 明细行 + 客户/审批投影 + 成本汇总） */
  @Get(':id')
  async detail(
    @Param('id') quoteId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.quotes.detail(this.requireUser(req).orgId, quoteId);
  }

  /** 09 §2 编辑报价（仅 draft；整体替换明细并重算成本/利润快照） */
  @Put(':id')
  async update(
    @Param('id') quoteId: string,
    @Body(new ZodValidationPipe(updateQuoteSchema)) dto: UpdateQuoteDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.quotes.update(user.orgId, user.sub, quoteId, dto);
  }

  /** 09 §3.2 获取 AI 定价建议（只读；服务端定价引擎推荐价/利润率/成本汇总/reasons） */
  @Post(':id/ai-pricing')
  async aiPricing(
    @Param('id') quoteId: string,
    @Body(new ZodValidationPipe(aiPricingRequestSchema)) dto: AiPricingRequestDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.quotes.aiPricing(this.requireUser(req).orgId, quoteId, dto);
  }

  /** 09 §3.3 提交审核（draft → waiting_approval，生成 quote/high 审批单并通知审批人） */
  @Post(':id/submit')
  async submit(
    @Param('id') quoteId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.quotes.submit(user.orgId, user.sub, user.role, quoteId);
  }

  /** 09 §3.4 发送报价（关联审批须 approved/edited_approved；走 16 邮箱通道外发） */
  @Post(':id/send')
  async send(
    @Param('id') quoteId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.quotes.send(user.orgId, user.sub, quoteId);
  }

  /** 09 §3.5 标记成交（sent → won；潜在客户自动升级为正式客户） */
  @Post(':id/mark-won')
  async markWon(
    @Param('id') quoteId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.quotes.markWon(user.orgId, user.sub, quoteId);
  }

  /** 09 §3.7 标记失效（draft/waiting_approval/sent → lost；原因选填） */
  @Post(':id/mark-lost')
  async markLost(
    @Param('id') quoteId: string,
    @Body(new ZodValidationPipe(markLostSchema)) dto: MarkLostDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.quotes.markLost(user.orgId, user.sub, quoteId, dto);
  }

  /** 09 §3.7 复活失效报价（仅 lost → draft） */
  @Post(':id/revive')
  async revive(
    @Param('id') quoteId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.quotes.revive(user.orgId, user.sub, quoteId);
  }

  /** 09 §3.8 议价梯度建议（只读；不返回底价/剩余底线） */
  @Get(':id/negotiation-ladder')
  async negotiationLadder(
    @Param('id') quoteId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.quotes.negotiationLadder(this.requireUser(req).orgId, quoteId);
  }

  /** 09 §3.6 导出报价单 PDF（服务端渲染；Content-Disposition 附件下载） */
  @Get(':id/pdf')
  @RawResponse()
  async exportPdf(
    @Param('id') quoteId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
    @Res() res: Response,
  ): Promise<void> {
    const user = this.requireUser(req);
    const { filename, buffer } = await this.quotes.exportPdf(user.orgId, user.sub, quoteId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new Error('未认证（JwtAuthGuard 缺失）');
    }
    return user;
  }
}

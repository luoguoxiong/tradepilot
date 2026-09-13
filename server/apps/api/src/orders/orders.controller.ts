import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { paginationQuerySchema } from '@tradepilot/shared';
import { BizException } from '@tradepilot/core';
import { OrdersService } from './orders.service.js';
import {
  createOrderSchema,
  executeOrderRiskSchema,
  listOrdersQuerySchema,
  updateOrderProgressSchema,
  updateOrderSchema,
  type CreateOrderDto,
  type ExecuteOrderRiskDto,
  type ListOrdersQueryDto,
  type UpdateOrderDto,
  type UpdateOrderProgressDto,
} from './orders.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';
import type { ApiKeyAuth } from '../open-api/api-key.service.js';

type OrdersRequest = Request & {
  authUser?: AccessTokenPayload;
  apiKeyAuth?: ApiKeyAuth;
};

/**
 * 订单中心接口（接口 10 §2/§3，P1）：
 * GET/POST /orders、GET /orders/summary|{id}|{id}/risk、
 * PUT /orders/{id}|{id}/progress、POST /orders/{id}/risk/execute、POST /orders/{id}/draft-email。
 *
 * AI 边界（10 §4）：金额/交期/数量变更与状态字段不允许 AI 身份写入——
 * 变更走 order_change 高危审批，进度写四要素由服务端推导状态。
 */
@Controller('orders')
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  /** 10 §1.1/§2 订单列表（状态 Tab + 客户 + 风险筛选，分页；附状态/风险计数） */
  @Get()
  async list(
    @Query(new ZodValidationPipe(listOrdersQuerySchema.merge(paginationQuerySchema)))
    query: ListOrdersQueryDto & { page: number; pageSize: number },
    @Req() req: OrdersRequest,
  ) {
    return this.orders.list(this.requireUser(req).orgId, query);
  }

  /** 10 §1.1 各档 Tab 与风险计数 */
  @Get('summary')
  async summary(@Req() req: OrdersRequest) {
    return this.orders.summary(this.requireUser(req).orgId);
  }

  /** 10 §3.1 创建订单（fromQuoteId 转单 / 手工建单） */
  @Post()
  async create(
    @Body(new ZodValidationPipe(createOrderSchema)) dto: CreateOrderDto,
    @Req() req: OrdersRequest,
  ) {
    const user = this.requireUser(req);
    return this.orders.create(user.orgId, user.sub, dto);
  }

  /** 10 §1.2 订单详情（头 + 进度 + 明细 + 风险洞察 + 变更中审批 + 进度时间线） */
  @Get(':id')
  async detail(@Param('id') orderId: string, @Req() req: OrdersRequest) {
    return this.orders.detail(this.requireUser(req).orgId, orderId);
  }

  /** 10 §3.2 变更订单（交期/金额/数量 → order_change 高危审批；AI 身份 40301） */
  @Put(':id')
  async update(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(updateOrderSchema)) dto: UpdateOrderDto,
    @Req() req: OrdersRequest,
  ) {
    this.assertHumanActor(req);
    const user = this.requireUser(req);
    return this.orders.update(user.orgId, user.sub, user.role, orderId, dto);
  }

  /** 10 §3.3 更新履约进度（四要素 → 状态推导 → 写流水 + 风险自动评估） */
  @Put(':id/progress')
  async updateProgress(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(updateOrderProgressSchema)) dto: UpdateOrderProgressDto,
    @Req() req: OrdersRequest,
  ) {
    const user = this.requireUser(req);
    return this.orders.updateProgress(user.orgId, user.sub, orderId, dto);
  }

  /** 10 §3.4 订单风险分析（规则引擎实时评估，AI 洞察覆盖原因与建议文案） */
  @Get(':id/risk')
  async risk(@Param('id') orderId: string, @Req() req: OrdersRequest) {
    return this.orders.risk(this.requireUser(req).orgId, orderId);
  }

  /** 10 §3.5 执行风险建议（internal → 建任务；customer → 草稿 + message_send 审批） */
  @Post(':id/risk/execute')
  async executeRisk(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(executeOrderRiskSchema)) dto: ExecuteOrderRiskDto,
    @Req() req: OrdersRequest,
  ) {
    const user = this.requireUser(req);
    return this.orders.executeRisk(user.orgId, user.sub, user.role, orderId, dto);
  }

  /** 10 §3.7 生成延期沟通草稿（进入 06 工作台草稿箱，人工确认后发送） */
  @Post(':id/draft-email')
  async draftEmail(@Param('id') orderId: string, @Req() req: OrdersRequest) {
    const user = this.requireUser(req);
    return this.orders.draftEmail(user.orgId, user.sub, orderId);
  }

  private requireUser(req: OrdersRequest): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw BizException.unauthorized('未认证（JwtAuthGuard 缺失）');
    }
    return user;
  }

  /**
   * AI/机器身份判定（10 §4 红线）：
   * - `x-api-key` 通道（request.apiKeyAuth）为机器调用通道；
   * - 显式 `x-actor-type: ai` 标记为 AI 发起。
   * 两者命中一律 40301，禁止 AI 直接改订单金额/交期/数量。
   */
  private assertHumanActor(req: OrdersRequest): void {
    const actorHeader = req.headers['x-actor-type'];
    const actor = typeof actorHeader === 'string' ? actorHeader.trim().toLowerCase() : '';
    if (req.apiKeyAuth || actor === 'ai') {
      throw BizException.forbidden(
        '订单金额/交期/数量变更须人工发起并走 order_change 审批，AI 身份不可直接变更（10 §4）',
      );
    }
  }
}

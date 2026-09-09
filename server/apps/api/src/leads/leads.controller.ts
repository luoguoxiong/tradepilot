/**
 * 03 AI 获客接口（接口 03 §2/§3，M5-B2）：
 * - GET /lead-hunter/summary
 * - POST /lead-tasks/parse
 * - POST /lead-tasks
 * - GET /leads、/leads/summary、/leads/{id}
 * - POST /leads/add-to-crm、/leads/batch-analyze
 */
import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { paginationQuerySchema } from '@tradepilot/shared';
import { resolveScope, type OrgScopeContext } from '@tradepilot/db';
import { LeadsService } from './leads.service.js';
import { CustomersService } from '../customers/customers.service.js';
import {
  addToCrmSchema,
  batchAnalyzeSchema,
  convertLeadSchema,
  createLeadTaskSchema,
  listLeadsQuerySchema,
  parseLeadTaskSchema,
  type AddToCrmDto,
  type BatchAnalyzeDto,
  type ConvertLeadDto,
  type CreateLeadTaskDto,
  type ListLeadsQuery,
  type ParseLeadTaskDto,
} from './leads.dto.js';
import {
  generateOutreachSchema,
  type GenerateOutreachDto,
} from '../customers/customers.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

@Controller()
export class LeadsController {
  constructor(
    @Inject(LeadsService) private readonly leads: LeadsService,
    @Inject(CustomersService) private readonly customers: CustomersService,
  ) {}

  /** B2 §1 工作台头部：员工状态 + 今日产出 + 当前任务 */
  @Get('lead-hunter/summary')
  async summary(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.leads.summary(this.ctx(req));
  }

  /** B2 §2 AI 解析目标文本 → 结构化字段 */
  @Post('lead-tasks/parse')
  async parse(
    @Body(new ZodValidationPipe(parseLeadTaskSchema)) dto: ParseLeadTaskDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.leads.parse(this.ctx(req), dto);
  }

  /** B2 §3 创建获客任务（复用 tasks 模块 lead_hunting） */
  @Post('lead-tasks')
  async createTask(
    @Body(new ZodValidationPipe(createLeadTaskSchema)) dto: CreateLeadTaskDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.leads.createTask(this.ctx(req), dto);
  }

  /** B2 §4 客户发现列表（筛选/分页） */
  @Get('leads')
  async list(
    @Query(new ZodValidationPipe(listLeadsQuerySchema.merge(paginationQuerySchema)))
    query: ListLeadsQuery & { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.leads.list(this.ctx(req), query);
  }

  /** B2 §4 各价值档数量 */
  @Get('leads/summary')
  async summaryCounts(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.leads.summaryCounts(this.ctx(req));
  }

  /** B2 §5 发现客户详情 */
  @Get('leads/:id')
  async detail(
    @Param('id') leadId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.leads.detail(this.ctx(req), leadId);
  }

  /** B2 §6 加入 CRM */
  @Post('leads/add-to-crm')
  async addToCrm(
    @Body(new ZodValidationPipe(addToCrmSchema)) dto: AddToCrmDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.leads.addToCrm(this.ctx(req), dto);
  }

  /** B2 §7 批量分析 */
  @Post('leads/batch-analyze')
  async batchAnalyze(
    @Body(new ZodValidationPipe(batchAnalyzeSchema)) dto: BatchAnalyzeDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.leads.batchAnalyze(this.ctx(req), dto);
  }

  // ===== B3 04 客户360° =====

  /** B3 POST /leads/{id}/convert 单条 lead 转 CRM */
  @Post('leads/:id/convert')
  async convert(
    @Param('id') leadId: string,
    @Body(new ZodValidationPipe(convertLeadSchema)) dto: ConvertLeadDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.leads.convert(this.ctx(req), leadId, dto);
  }

  /** B3 §3.4 POST /contacts/{id}/generate-outreach AI 生成开发信 */
  @Post('contacts/:id/generate-outreach')
  async generateOutreach(
    @Param('id') contactId: string,
    @Body(new ZodValidationPipe(generateOutreachSchema)) dto: GenerateOutreachDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.customers.generateOutreach(this.ctx(req), contactId, dto);
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
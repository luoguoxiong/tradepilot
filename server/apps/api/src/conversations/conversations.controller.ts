import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { paginationQuerySchema } from '@tradepilot/shared';
import { resolveScope, type OrgScopeContext } from '@tradepilot/db';
import { ConversationsService } from './conversations.service.js';
import {
  listConversationsQuerySchema,
  type ListConversationsQuery,
} from './conversations.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 06 AI 销售工作台 · 会话读侧接口（接口 06 §2，P0，M5-A3）：
 * GET /conversations、GET /conversations/{id}、GET /conversations/{id}/copilot。
 * 写侧（ai-draft / send / messages / ask-ai / suggestions）随 M5-C1/C2 交付。
 * scope 经 query 传入（缺省取角色上限，接口总览 §4.4），sales=self 只看自己客户会话。
 */
@Controller('conversations')
export class ConversationsController {
  constructor(@Inject(ConversationsService) private readonly conversations: ConversationsService) {}

  /** 06 §3.1 会话列表（keyword/priority/unreadOnly/mailboxId + 多邮箱聚合 + 分页） */
  @Get()
  async list(
    @Query(
      new ZodValidationPipe(listConversationsQuerySchema.merge(paginationQuerySchema)),
    )
    query: ListConversationsQuery & {
      page: number;
      pageSize: number;
      keyword?: string;
      sortOrder?: 'asc' | 'desc';
    },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    const ctx: OrgScopeContext = {
      orgId: user.orgId,
      userId: user.sub,
      role: user.role,
      scope: resolveScope(user.role, query.scope),
    };
    return this.conversations.list(ctx, query);
  }

  /** 06 §2 会话详情（上下文 + 消息时间线，读即清未读） */
  @Get(':id')
  async detail(@Param('id') conversationId: string, @Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.conversations.detail(this.ctx(req), conversationId);
  }

  /** 06 §1.3 Copilot 数据（意图/概率/建议） */
  @Get(':id/copilot')
  async copilot(@Param('id') conversationId: string, @Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.conversations.copilot(this.ctx(req), conversationId);
  }

  /** 无 query scope 的资源级访问：取角色上限（detail/copilot 内部做 self 越权校验） */
  private ctx(req: Request & { authUser?: AccessTokenPayload }): OrgScopeContext {
    const user = this.requireUser(req);
    return {
      orgId: user.orgId,
      userId: user.sub,
      role: user.role,
      scope: resolveScope(user.role),
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

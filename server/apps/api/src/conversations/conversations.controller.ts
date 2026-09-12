import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { paginationQuerySchema } from '@tradepilot/shared';
import { resolveScope, type OrgScopeContext } from '@tradepilot/db';
import { ConversationsService } from './conversations.service.js';
import {
  aiDraftSchema,
  askAiSchema,
  listConversationsQuerySchema,
  sendMessageSchema,
  suggestionsApplySchema,
  updateMessageSchema,
  type AiDraftDto,
  type AskAiDto,
  type ListConversationsQuery,
  type SendMessageDto,
  type SuggestionsApplyDto,
  type UpdateMessageDto,
} from './conversations.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 06 AI 销售工作台 · 会话接口（接口 06 §2/§3，P0，M5-A3 读侧 + M5-C1/C2 写侧）：
 * 读侧：GET /conversations、GET /conversations/{id}、GET /conversations/{id}/copilot；
 * 写侧：POST /conversations/{id}/ai-draft（regenerate）、POST /conversations/{id}/send、
 *   POST /conversations/{id}/ask-ai；PUT /messages/{id} 与 POST /copilot/suggestions/apply
 *   分别在 MessagesController / CopilotController（同模块）。
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

  /** 06 §2 会话详情（上下文 + 消息时间线，读即清未读；waiting_approval 消息补 approvalId） */
  @Get(':id')
  async detail(@Param('id') conversationId: string, @Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.conversations.detail(this.ctx(req), conversationId);
  }

  /** 06 §1.3 Copilot 数据（意图/概率/建议） */
  @Get(':id/copilot')
  async copilot(@Param('id') conversationId: string, @Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.conversations.copilot(this.ctx(req), conversationId);
  }

  /** 06 §3.2 POST /conversations/{id}/ai-draft 生成 AI 草稿 */
  @Post(':id/ai-draft')
  async aiDraft(
    @Param('id') conversationId: string,
    @Body(new ZodValidationPipe(aiDraftSchema)) dto: AiDraftDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.conversations.aiDraft(this.ctx(req), conversationId, dto);
  }

  /** 06 §3.2 POST /conversations/{id}/ai-draft/regenerate 重新生成（新草稿消息） */
  @Post(':id/ai-draft/regenerate')
  async regenerate(
    @Param('id') conversationId: string,
    @Body(new ZodValidationPipe(aiDraftSchema)) dto: AiDraftDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.conversations.regenerate(this.ctx(req), conversationId, dto);
  }

  /** 06 §3.3 POST /conversations/{id}/send 发送邮件（服务端按审批策略决定分支 A/B） */
  @Post(':id/send')
  async send(
    @Param('id') conversationId: string,
    @Body(new ZodValidationPipe(sendMessageSchema)) dto: SendMessageDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.conversations.send(this.ctx(req), conversationId, dto);
  }

  /** 06 §3.5 POST /conversations/{id}/ask-ai RAG 检索问答 */
  @Post(':id/ask-ai')
  async askAi(
    @Param('id') conversationId: string,
    @Body(new ZodValidationPipe(askAiSchema)) dto: AskAiDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.conversations.askAi(this.ctx(req), conversationId, dto);
  }

  /** 无 query scope 的资源级访问：取角色上限（detail/copilot/写侧内部做 self 越权校验） */
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

/** 06 §3.2 PUT /messages/{id}：编辑/保存草稿（路径前缀 /messages，同模块独立路由） */
@Controller('messages')
export class MessagesController {
  constructor(@Inject(ConversationsService) private readonly conversations: ConversationsService) {}

  @Put(':id')
  async update(
    @Param('id') messageId: string,
    @Body(new ZodValidationPipe(updateMessageSchema)) dto: UpdateMessageDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.conversations.updateMessage(
      { orgId: user.orgId, userId: user.sub, role: user.role, scope: resolveScope(user.role) },
      messageId,
      dto,
    );
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new Error('未认证（JwtAuthGuard 缺失）');
    }
    return user;
  }
}

/** 06 §3.4 POST /copilot/suggestions/apply：执行勾选建议（路径前缀 /copilot） */
@Controller('copilot')
export class CopilotController {
  constructor(@Inject(ConversationsService) private readonly conversations: ConversationsService) {}

  @Post('suggestions/apply')
  async apply(
    @Body(new ZodValidationPipe(suggestionsApplySchema)) dto: SuggestionsApplyDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.conversations.applySuggestions(
      { orgId: user.orgId, userId: user.sub, role: user.role, scope: resolveScope(user.role) },
      dto,
    );
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new Error('未认证（JwtAuthGuard 缺失）');
    }
    return user;
  }
}

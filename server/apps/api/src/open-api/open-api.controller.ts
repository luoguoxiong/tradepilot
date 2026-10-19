/**
 * 开放 API / Webhook 配置接口（P1-X-21/22，16 FR-11，接口 16 §2）：
 * - `GET/POST/DELETE /settings/api-keys`（明文密钥仅创建响应返回一次）；
 * - `GET/POST/DELETE /settings/webhooks`（secret 加密入库、永不回显）。
 * 凭证属敏感配置：读写均仅 admin（03 §4，与 AI 模型配置同口径）。
 */
import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { BizException, ErrorCode } from '@tradepilot/core';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AccessTokenPayload } from '../auth/token.service.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { ApiKeyService } from './api-key.service.js';
import { createApiKeySchema, createWebhookSchema } from './open-api.dto.js';
import type { CreateApiKeyDto, CreateWebhookDto } from './open-api.dto.js';
import { WebhookService } from './webhook.service.js';

type AuthRequest = Request & { authUser?: AccessTokenPayload };

@Controller('settings')
export class OpenApiController {
  constructor(
    @Inject(ApiKeyService) private readonly apiKeys: ApiKeyService,
    @Inject(WebhookService) private readonly webhooks: WebhookService,
  ) {}

  // ===== API Key（06 §5.1）=====

  @Roles('admin')
  @Get('api-keys')
  async listApiKeys(@Req() req: AuthRequest) {
    return this.apiKeys.list(requireUser(req).orgId);
  }

  @Roles('admin')
  @Post('api-keys')
  async createApiKey(
    @Body(new ZodValidationPipe(createApiKeySchema)) dto: CreateApiKeyDto,
    @Req() req: AuthRequest,
  ) {
    const user = requireUser(req);
    return this.apiKeys.create(user.orgId, user.sub, dto);
  }

  @Roles('admin')
  @Delete('api-keys/:id')
  async revokeApiKey(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.apiKeys.revoke(requireUser(req).orgId, id);
  }

  // ===== 出站 Webhook（06 §5.2）=====

  @Roles('admin')
  @Get('webhooks')
  async listWebhooks(@Req() req: AuthRequest) {
    return this.webhooks.list(requireUser(req).orgId);
  }

  @Roles('admin')
  @Post('webhooks')
  async createWebhook(
    @Body(new ZodValidationPipe(createWebhookSchema)) dto: CreateWebhookDto,
    @Req() req: AuthRequest,
  ) {
    return this.webhooks.create(requireUser(req).orgId, dto);
  }

  @Roles('admin')
  @Delete('webhooks/:id')
  async removeWebhook(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.webhooks.remove(requireUser(req).orgId, id);
  }
}

function requireUser(req: AuthRequest): AccessTokenPayload {
  if (!req.authUser) {
    throw new BizException(ErrorCode.UNAUTHORIZED, '未认证或登录已失效');
  }
  return req.authUser;
}

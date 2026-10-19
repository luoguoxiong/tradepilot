/**
 * 开放 API 模块（P1-X-21/22，16 FR-11 / 后端技术方案 06 §5）：
 * - ApiKeyService：密钥 CRUD + 入站鉴权（scopes / 限流 / last_used_at）；
 * - WebhookService：订阅 CRUD（secret_enc 密文）；
 * - 两者被 AuthModule 复用（JwtAuthGuard 内 `x-api-key` 分支），故此处导出。
 * 出站投递在 worker 侧（q:webhook），本模块不承载。
 */
import { Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service.js';
import { OpenApiController } from './open-api.controller.js';
import { WebhookService } from './webhook.service.js';

@Module({
  controllers: [OpenApiController],
  providers: [ApiKeyService, WebhookService],
  exports: [ApiKeyService, WebhookService],
})
export class OpenApiModule {}

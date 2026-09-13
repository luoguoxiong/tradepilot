import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { OpenApiModule } from '../open-api/open-api.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { ScopesGuard } from './guards/scopes.guard.js';

/**
 * 认证与 RBAC 模块（技术方案 03）。
 * Guard 链顺序 = APP_GUARD 注册顺序：JwtAuthGuard → RolesGuard → ScopesGuard（03 §2.2）；
 * JwtAuthGuard 的 `x-api-key` 分支依赖 OpenApiModule 导出的 ApiKeyService（P1-X-22）；
 * ResourceGuard（资源级 owner/团队校验）随业务模块落地（scope 工具在 @tradepilot/db）。
 */
@Module({
  imports: [OpenApiModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}

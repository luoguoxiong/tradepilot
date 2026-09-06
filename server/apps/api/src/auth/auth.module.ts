import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';

/**
 * 认证与 RBAC 模块（技术方案 03）。
 * Guard 链顺序 = APP_GUARD 注册顺序：JwtAuthGuard → RolesGuard；
 * ResourceGuard（资源级 owner/团队校验）随业务模块落地（scope 工具在 @tradepilot/db）。
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}

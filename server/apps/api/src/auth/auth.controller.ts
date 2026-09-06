import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { BizException, ErrorCode } from '@tradepilot/core';
import { AuthService } from './auth.service.js';
import {
  acceptInvitationSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
} from './auth.dto.js';
import type {
  AcceptInvitationDto,
  LoginDto,
  LogoutDto,
  RefreshDto,
  RegisterDto,
} from './auth.dto.js';
import { Public } from './decorators/public.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from './token.service.js';

/**
 * 认证接口（接口 16 §2/§3.1/§3.2 / 技术方案 03 §1.1）：
 * register / login / refresh / invitations/accept 公开；logout / me 需认证（Guard 全局链）。
 */
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  async register(@Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body(new ZodValidationPipe(loginSchema)) dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, req.ip ?? 'unknown');
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body(new ZodValidationPipe(refreshSchema)) dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  /** 接受邀请（03 §1.1）：邀请链接落地页提交 → 激活账号并直接登录 */
  @Public()
  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  async acceptInvitation(
    @Body(new ZodValidationPipe(acceptInvitationSchema)) dto: AcceptInvitationDto,
  ) {
    return this.auth.acceptInvitation(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Body(new ZodValidationPipe(logoutSchema)) dto: LogoutDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.auth.logout(this.requireUser(req).sub, dto.refreshToken);
  }

  @Get('me')
  async me(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    const user = this.requireUser(req);
    return this.auth.me(user.sub, user.orgId);
  }

  /** 非公开路由 JwtAuthGuard 必然回填 authUser；防御式兜底 */
  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '未认证或登录已失效');
    }
    return user;
  }
}

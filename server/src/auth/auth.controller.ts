import { Body, Controller, Get, Inject, Post } from '@nestjs/common';

import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './guards/jwt-auth.guard';
import { AuthService } from './auth.service';
import type { AuthUser } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() body: unknown) {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  login(@Body() body: unknown) {
    return this.auth.login(body);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}

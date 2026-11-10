import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { LoginSchema, RegisterSchema } from './auth.schemas';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

const INVALID_CREDENTIALS = { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' };

@Injectable()
export class AuthService {
  constructor(
    // 注：tsx/esbuild 不支持 emitDecoratorMetadata，注入必须显式 @Inject
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  async register(input: unknown): Promise<{ token: string; user: AuthUser }> {
    const { email, password, name } = RegisterSchema.parse(input);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException({ code: 'EMAIL_TAKEN', message: 'Email already registered' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.prisma.user.create({
      data: { email, name, passwordHash },
    });
    return this.issue(user);
  }

  async login(input: unknown): Promise<{ token: string; user: AuthUser }> {
    const { email, password } = LoginSchema.parse(input);
    const user = await this.prisma.user.findUnique({ where: { email } });
    // 统一错误信息，不区分“邮箱不存在/密码错误”，防用户枚举
    if (!user) throw new UnauthorizedException(INVALID_CREDENTIALS);
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException(INVALID_CREDENTIALS);
    return this.issue(user);
  }

  private issue(user: User): { token: string; user: AuthUser } {
    const token = this.jwt.sign({ sub: user.id, email: user.email, name: user.name });
    // 不回传 passwordHash 等敏感字段
    return { token, user: { id: user.id, email: user.email, name: user.name } };
  }
}

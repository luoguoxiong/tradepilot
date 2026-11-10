import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthUser } from '../auth.service';

/** 从 JWT Guard 注入的 req.user 取当前用户 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    return req.user;
  },
);

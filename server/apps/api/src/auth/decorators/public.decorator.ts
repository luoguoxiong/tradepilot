import { SetMetadata } from '@nestjs/common';

/** 跳过 JwtAuthGuard 的公开路由（登录/注册/刷新/探针等） */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

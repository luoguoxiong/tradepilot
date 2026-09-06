import { SetMetadata } from '@nestjs/common';
import type { Role } from '@tradepilot/core';

/**
 * 角色白名单（技术方案 03 §2.2）：未标注 = 三角色可访问。
 * 例：@Roles('admin', 'manager')
 */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

import { SetMetadata } from '@nestjs/common';

/** scope 元数据键（ScopesGuard 读取） */
export const SCOPES_KEY = 'auth:scopes';

/**
 * 声明开放 API 访问所需 scope（P1-X-22 / 06 §5.1）。
 *
 * 语义：
 * - 仅约束 **API Key 通道**（`x-api-key`）；JWT 通道由 `@Roles` 负责，不受影响；
 * - 标注了 `@Scopes` 的端点若被 API Key 访问，必须命中全部 scope，否则 40301；
 * - **未标注 `@Scopes` 的端点不允许 API Key 访问**（fail-closed，防止误开放）。
 */
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);

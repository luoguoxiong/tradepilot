import { Body, Controller, Delete, Get, Inject, Param, Patch } from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.service';
import { IntegrationsService, type IntegrationView } from './integrations.service';
import { ProviderParamSchema, SaveIntegrationSchema } from './integrations.schemas';

@Controller('integrations')
export class IntegrationsController {
  constructor(@Inject(IntegrationsService) private readonly integrations: IntegrationsService) {}

  /** 列出全部集成配置（掩码，不回明文 Key） */
  @Get()
  list(@CurrentUser() user: AuthUser): Promise<IntegrationView[]> {
    return this.integrations.list(user.id);
  }

  @Patch(':provider')
  async save(
    @Param('provider') providerRaw: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<IntegrationView> {
    const provider = ProviderParamSchema.parse(providerRaw); // 非法 → 422
    const input = SaveIntegrationSchema.parse(body);
    return this.integrations.save(user.id, provider, input);
  }

  @Delete(':provider')
  async remove(
    @Param('provider') providerRaw: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    const provider = ProviderParamSchema.parse(providerRaw);
    await this.integrations.delete(user.id, provider);
    return { ok: true };
  }
}

import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { decryptConfig, encryptConfig, maskKey } from './crypto.util';

export const INTEGRATION_PROVIDERS = ['google', 'apollo', 'customs'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export interface IntegrationView {
  provider: string;
  configured: boolean;
  keyPreview: string | null;
}

export interface IntegrationConfig {
  apiKey: string;
  extra: Record<string, string>;
}

@Injectable()
export class IntegrationsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<IntegrationView[]> {
    const rows = await this.prisma.integration.findMany({ where: { userId } });
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    return INTEGRATION_PROVIDERS.map((provider) => {
      const row = byProvider.get(provider);
      if (!row) return { provider, configured: false, keyPreview: null };
      let apiKey: string | undefined;
      try {
        apiKey = decryptConfig(row.encryptedConfig).apiKey;
      } catch {
        apiKey = undefined;
      }
      return { provider, configured: Boolean(apiKey), keyPreview: maskKey(apiKey) };
    });
  }

  /** 保存（upsert）某 provider 的 Key，加密落库 */
  async save(
    userId: string,
    provider: IntegrationProvider,
    input: { apiKey: string; extra?: Record<string, string> },
  ): Promise<IntegrationView> {
    const encrypted = encryptConfig({ apiKey: input.apiKey, ...input.extra });
    await this.prisma.integration.upsert({
      where: { userId_provider: { userId, provider } },
      update: { encryptedConfig: encrypted },
      create: { userId, provider, encryptedConfig: encrypted },
    });
    return { provider, configured: true, keyPreview: maskKey(input.apiKey) };
  }

  /** Adapter 工厂用：解密读取某 provider 配置 */
  async getConfig(userId: string, provider: IntegrationProvider): Promise<IntegrationConfig | null> {
    const row = await this.prisma.integration.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!row) return null;
    try {
      const plain = decryptConfig(row.encryptedConfig);
      const { apiKey, ...extra } = plain;
      if (!apiKey) return null;
      return { apiKey, extra };
    } catch {
      throw new ServiceUnavailableException({
        code: 'INTEGRATION_DECRYPT_FAILED',
        message: '无法解密已保存的 API 配置（APP_ENCRYPTION_KEY 变更？），请在 Settings 重新保存',
      });
    }
  }

  async delete(userId: string, provider: IntegrationProvider): Promise<void> {
    try {
      await this.prisma.integration.delete({ where: { userId_provider: { userId, provider } } });
    } catch {
      throw new NotFoundException({ code: 'INTEGRATION_NOT_FOUND', message: '该集成尚未配置' });
    }
  }
}

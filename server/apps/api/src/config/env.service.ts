import { Injectable } from '@nestjs/common';
import type { ApiEnv } from '@tradepilot/shared';
import { loadEnv } from './env.js';

/**
 * 配置提供者：以 Zod 校验后的环境变量为基础（fail-fast）。
 * 业务配置（org 级，如 send_rules / ai_model_setting）一律读库，不进环境变量。
 */
@Injectable()
export class EnvService {
  readonly env: ApiEnv;

  constructor() {
    this.env = loadEnv();
  }

  get port(): number {
    return this.env.API_PORT;
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }
}

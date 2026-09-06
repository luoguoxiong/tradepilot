import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Registry } from 'prom-client';
import { RawResponse } from '../decorators/raw-response.decorator.js';
import { PROM_REGISTRY } from './metrics.tokens.js';

/**
 * Prometheus 抓取端点（09 §2：/metrics 不做 envelope 包装、pino autoLogging 忽略）。
 */
@Controller('metrics')
@RawResponse()
export class MetricsController {
  constructor(@Inject(PROM_REGISTRY) private readonly registry: Registry) {}

  @Get()
  async metrics(@Res() res: Response): Promise<void> {
    const body = await this.registry.metrics();
    res.setHeader('Content-Type', this.registry.contentType);
    res.send(body);
  }
}

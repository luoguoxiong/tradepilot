import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'tradepilot:raw-response';

/**
 * 标记响应不做 envelope 包装（如 /metrics 的 Prometheus 文本输出）。
 */
export const RawResponse = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RAW_RESPONSE_KEY, true);

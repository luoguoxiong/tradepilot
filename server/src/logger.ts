import pino from 'pino';
import { getEnv } from './config';

/** 结构化 JSON 日志唯一实例（请求日志经 pino-http 注入，见 main.ts） */
export const logger = pino({
  level: getEnv().NODE_ENV === 'development' ? 'debug' : 'info',
  base: { service: 'tradepilot-api' },
});

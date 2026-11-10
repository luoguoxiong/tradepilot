import 'reflect-metadata';

import { createApp } from './create-app';
import { getEnv } from './config';
import { logger } from './logger';

async function bootstrap(): Promise<void> {
  const env = getEnv();
  const app = await createApp();
  await app.listen(env.PORT);
  logger.info({ port: env.PORT, health: `http://127.0.0.1:${env.PORT}/api/health` }, 'TradePilot API started');
}

void bootstrap();

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AdaptersModule } from '../adapters/adapters.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { getEnv } from '../config';
import { LeadDiscoveryProcessor } from './processor/lead-discovery.processor';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password ? { password: parsed.password } : {}),
  };
}

@Module({
  imports: [
    BullModule.forRoot({
      connection: parseRedisUrl(getEnv().REDIS_URL),
    }),
    BullModule.registerQueue({
      name: 'lead-discovery',
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    }),
    IntegrationsModule,
    AdaptersModule,
  ],
  controllers: [TasksController],
  providers: [TasksService, LeadDiscoveryProcessor],
})
export class TasksModule {}

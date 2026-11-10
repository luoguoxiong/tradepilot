import { Module } from '@nestjs/common';

import { IntegrationsModule } from '../integrations/integrations.module';
import { RedisModule } from '../redis/redis.module';
import { AdapterFactory } from './adapter.factory';
import { QuotaService } from './quota.service';

@Module({
  imports: [IntegrationsModule, RedisModule],
  providers: [AdapterFactory, QuotaService],
  exports: [AdapterFactory, QuotaService],
})
export class AdaptersModule {}

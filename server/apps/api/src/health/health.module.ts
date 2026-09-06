import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { EnvService } from '../config/env.service.js';

@Module({
  controllers: [HealthController],
  providers: [EnvService],
})
export class HealthModule {}

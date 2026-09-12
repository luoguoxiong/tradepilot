import { Module } from '@nestjs/common';
import { FollowUpsController, FollowUpTasksController, FollowUpStrategiesController } from './follow-ups.controller.js';
import { FollowUpsService } from './follow-ups.service.js';

/** 07-AI 自动跟进模块（接口 07，M5-D1） */
@Module({
  controllers: [FollowUpsController, FollowUpTasksController, FollowUpStrategiesController],
  providers: [FollowUpsService],
  exports: [FollowUpsService],
})
export class FollowUpsModule {}

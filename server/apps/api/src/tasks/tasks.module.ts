import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller.js';
import { TaskStreamController } from './task-stream.controller.js';
import { TasksService } from './tasks.service.js';

/** 任务中心模块（接口 14 §3 P0 / 技术方案 04 §2、§6 SSE） */
@Module({
  controllers: [TasksController, TaskStreamController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}

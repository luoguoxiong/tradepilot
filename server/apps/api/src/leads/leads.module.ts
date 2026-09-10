import { Module } from '@nestjs/common';
import { LoggingModule } from '../common/logger/logging.module.js';
import { LeadsController } from './leads.controller.js';
import { LeadsService } from './leads.service.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { CustomersModule } from '../customers/customers.module.js';

/** 03 AI 获客模块（接口 03，M5-B2） */
@Module({
  imports: [LoggingModule, TasksModule, CustomersModule],
  controllers: [LeadsController],
  providers: [LeadsService],
  exports: [LeadsService],
})
export class LeadsModule {}

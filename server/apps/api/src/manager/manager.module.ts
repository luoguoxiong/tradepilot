import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { FollowUpsModule } from '../follow-ups/follow-ups.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { ManagerController } from './manager.controller.js';
import { ManagerService } from './manager.service.js';

/**
 * 13 AI 外贸经理模块（P1-13）：
 * 指标复用 15 AnalyticsService、效率复用 02 EmployeesService、一键动作复用 03/07、报告任务复用 14 TasksService，
 * 故仅做跨模块 DI 组装，不重复实现聚合口径。
 */
@Module({
  imports: [AnalyticsModule, EmployeesModule, LeadsModule, FollowUpsModule, TasksModule],
  controllers: [ManagerController],
  providers: [ManagerService],
  exports: [ManagerService],
})
export class ManagerModule {}

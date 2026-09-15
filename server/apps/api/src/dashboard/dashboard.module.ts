import { Module } from '@nestjs/common';
import { ManagerModule } from '../manager/manager.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

/**
 * 01 Dashboard 工作台模块（接口 01 §2 P0，M5-D2；只读聚合）。
 * D3：每日报告入口复用 13 经营报告能力（ManagerModule 导出 ManagerService，不重复实现报告口径）。
 */
@Module({
  imports: [ManagerModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}

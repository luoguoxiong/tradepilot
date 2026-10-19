import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { SettingsModule } from '../settings/settings.module.js';
import { TasksModule } from '../tasks/tasks.module.js';

/**
 * 订单中心模块（接口 10 P1 / 需求 10）：
 * 订单列表/详情、报价转单与手工建单、履约进度更新（状态推导）、
 * 变更审批（order_change 高危）、履约风险评估与建议执行（建任务/生成沟通草稿）。
 * 依赖 SettingsModule（产品与报价规则 / 审批超时）、TasksModule（风险跟进任务承接）。
 */
@Module({
  imports: [SettingsModule, TasksModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}

import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { TasksModule } from '../tasks/tasks.module.js';

/**
 * 产品中心模块（接口 08 P1 / 需求 08 §4）：
 * 产品 CRUD + 资料归档知识中心 + AI 分析与知识生成/确认（依赖 TasksModule 投递 product_knowledge 任务）。
 */
@Module({
  imports: [TasksModule],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}

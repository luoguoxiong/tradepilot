import { Module } from '@nestjs/common';
import { QuotesController } from './quotes.controller.js';
import { QuotesService } from './quotes.service.js';
import { SettingsModule } from '../settings/settings.module.js';

/**
 * 报价中心模块（接口 09 P1 / 需求 09）：
 * 报价 CRUD + 定价引擎（成本/汇率快照、利润红线）+ 状态机（审核/外发/成交/失效/复活）
 * + AI 定价建议 + 议价梯度 + PDF 导出；依赖 SettingsModule 读取 16「产品与报价规则」。
 */
@Module({
  imports: [SettingsModule],
  controllers: [QuotesController],
  providers: [QuotesService],
  exports: [QuotesService],
})
export class QuotesModule {}

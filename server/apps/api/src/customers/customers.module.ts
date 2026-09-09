import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

/** 05 CRM 客户中心模块（接口 05 §2 P0，M5-A4 基座；软删/批量/contacts/activities 随 B1） */
@Module({
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}

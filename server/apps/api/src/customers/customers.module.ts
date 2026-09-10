import { Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';
import { TasksModule } from '../tasks/tasks.module.js';

/** 05 CRM 客户中心模块（接口 05 §2 P0，M5-A4/B1；B3 04 客户360°） */
@Module({
  imports: [TasksModule],
  controllers: [CustomersController, ContactsController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}

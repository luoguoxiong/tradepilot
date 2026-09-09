import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller.js';
import { EmployeesService } from './employees.service.js';
import { TasksModule } from '../tasks/tasks.module.js';

/** 02 AI 数字员工中心模块（接口 02 §2/§3 P0，M5-C3） */
@Module({
  imports: [TasksModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}

import { Module } from '@nestjs/common';
import { OrgController } from './org.controller.js';
import { OrgService } from './org.service.js';

/** 组织与成员模块（接口 16 §1.2~§1.4 / 技术方案 03 §4/§6） */
@Module({
  controllers: [OrgController],
  providers: [OrgService],
  exports: [OrgService],
})
export class OrgModule {}

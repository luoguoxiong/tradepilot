import { Module } from '@nestjs/common';
import { MailboxService } from './mailbox.service.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';
import { OrgModule } from '../org/org.module.js';

/** 系统设置模块（接口 16 §1.5/§1.7/§1.8：邮箱连接 / 权限 / 通知 / AI 模型） */
@Module({
  imports: [OrgModule],
  controllers: [SettingsController],
  providers: [MailboxService, SettingsService],
  exports: [SettingsService, MailboxService],
})
export class SettingsModule {}

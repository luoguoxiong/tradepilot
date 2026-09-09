import { Module } from '@nestjs/common';
import { LoggingModule } from '../common/logger/logging.module.js';
import {
  ConversationsController,
  CopilotController,
  MessagesController,
} from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';

/** 06 AI 销售工作台 · 会话模块（接口 06 §2/§3 P0，读侧 M5-A3；写侧 M5-C1/C2） */
@Module({
  imports: [LoggingModule],
  controllers: [ConversationsController, MessagesController, CopilotController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}

import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';

/** 06 AI 销售工作台 · 会话模块（接口 06 §2 P0，读侧 M5-A3；写侧随 M5-C1/C2） */
@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}

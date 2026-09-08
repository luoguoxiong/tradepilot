import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { RateLimitMiddleware } from '../middleware/rate-limit.middleware.js';
import { RedisModule } from '../../redis/redis.module.js';

/**
 * 安全基线模块（M4 #11，后端技术方案 08 §4）：全局限流中间件。
 * 其余安全基线落点：外发滥用防护 = tools/email_send 内容合规钩子（08 §6）；
 * Break-up 强制人工 = ApprovalGate（07 §4）；审计串联 = approval_request/log +
 * ai_task(_log) + customer_activity 全链路留痕（M3/M4 链路内置）。
 */
@Module({
  imports: [RedisModule],
})
export class SecurityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RateLimitMiddleware).forRoutes('*');
  }
}

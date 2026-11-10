import { Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.service';
import { CustomsService } from './customs.service';

const CompanyParamsSchema = z.object({ id: z.string().min(1) });

@Controller('companies/:id/customs-records')
export class CustomsController {
  constructor(@Inject(CustomsService) private readonly customs: CustomsService) {}

  /** 触发海关数据查询（Real / Mock DEMO）并返回记录 + 聚合摘要 */
  @Post('query')
  query(@Param() params: unknown, @CurrentUser() user: AuthUser) {
    const { id } = CompanyParamsSchema.parse(params);
    return this.customs.queryAndStore(id, user.id);
  }

  /** 已存记录 + 摘要（不触发外部调用） */
  @Get()
  list(@Param() params: unknown) {
    const { id } = CompanyParamsSchema.parse(params);
    return this.customs.listWithSummary(id);
  }
}

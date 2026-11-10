import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.service';
import { TasksService } from './tasks.service';
import { CreateSearchTaskSchema, RetryTaskSchema } from './tasks.schemas';

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

@Controller('search-tasks')
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const input = CreateSearchTaskSchema.parse(body);
    return this.tasks.create(user.id, input);
  }

  @Get()
  list(@Query() query: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    const { page, pageSize } = ListQuerySchema.parse(query);
    return this.tasks.list(user.id, page, pageSize);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tasks.get(user.id, id);
  }

  @Post(':id/retry')
  retry(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const input = RetryTaskSchema.parse(body);
    return this.tasks.retry(user.id, id, input);
  }
}

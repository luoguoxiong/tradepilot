import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.service';
import { ContactsService } from './contacts.service';
import { DiscoverContactsSchema, ManualContactSchema } from './contacts.schemas';

const CompanyParamsSchema = z.object({ id: z.string().min(1) });

@Controller('companies/:id/contacts')
export class ContactsController {
  constructor(@Inject(ContactsService) private readonly contacts: ContactsService) {}

  @Get()
  list(@Param() params: unknown) {
    const { id } = CompanyParamsSchema.parse(params);
    return this.contacts.listByCompany(id);
  }

  /** 手动补充联系人（挖掘失败/无邮箱时的兜底） */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  addManual(@Param() params: unknown, @Body() body: unknown) {
    const { id } = CompanyParamsSchema.parse(params);
    return this.contacts.addManual(id, ManualContactSchema.parse(body));
  }

  /** 触发联系人挖掘（Apollo Real / Mock 降级，DEMO 标注） */
  @Post('discover')
  discover(@Param() params: unknown, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { id } = CompanyParamsSchema.parse(params);
    const { titles } = DiscoverContactsSchema.parse(body ?? {});
    return this.contacts.discover(id, user.id, titles);
  }
}

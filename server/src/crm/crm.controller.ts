import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.service';
import { CrmService } from './crm.service';
import { CsvService } from './csv.service';
import { AddActivitySchema, ListCustomersQuerySchema, TransitionSchema } from './crm.schemas';

const IdParamsSchema = z.object({ id: z.string().min(1) });
const ExportTypeSchema = z.enum(['companies', 'contacts']);
const ImportBodySchema = z.object({
  type: ExportTypeSchema,
  csv: z.string().min(1, 'csv content is required').max(5_000_000),
});

@Controller('crm')
export class CrmController {
  constructor(
    @Inject(CrmService) private readonly crm: CrmService,
    @Inject(CsvService) private readonly csv: CsvService,
  ) {}

  /** Dashboard 汇总（待跟进卡片等） */
  @Get('summary')
  summary() {
    return this.crm.summary();
  }

  @Get('customers')
  list(@Query() query: Record<string, unknown>) {
    return this.crm.list(ListCustomersQuerySchema.parse(query));
  }

  @Get('customers/:id')
  getCustomer(@Param() params: unknown) {
    const { id } = IdParamsSchema.parse(params);
    return this.crm.getCustomer(id);
  }

  /** 状态流转（非法跳转 → 400 INVALID_TRANSITION） */
  @Post('customers/:id/transition')
  transition(@Param() params: unknown, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { id } = IdParamsSchema.parse(params);
    const { to, note } = TransitionSchema.parse(body);
    return this.crm.transition(id, user.id, to, note);
  }

  @Post('customers/:id/activities')
  @HttpCode(HttpStatus.CREATED)
  addActivity(@Param() params: unknown, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { id } = IdParamsSchema.parse(params);
    return this.crm.addActivity(id, user.id, AddActivitySchema.parse(body));
  }

  /** CSV 导出（text/csv，UTF-8 BOM） */
  @Get('export')
  async export(@Query() query: Record<string, unknown>, @Res() res: Response) {
    const type = ExportTypeSchema.parse(query.type);
    const content =
      type === 'companies' ? await this.csv.exportCompanies() : await this.csv.exportContacts();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tradepilot-${type}.csv"`);
    res.status(HttpStatus.OK).send(content);
  }

  /** CSV 导入：{ type, csv } */
  @Post('import')
  import(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { type, csv } = ImportBodySchema.parse(body);
    return type === 'companies' ? this.csv.importCompanies(csv, user.id) : this.csv.importContacts(csv, user.id);
  }
}

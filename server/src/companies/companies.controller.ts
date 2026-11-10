import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.service';
import { CompaniesService } from './companies.service';
import { FavoriteSchema, ImportCrmSchema, ListCompaniesQuerySchema } from './companies.schemas';

@Controller('companies')
export class CompaniesController {
  constructor(@Inject(CompaniesService) private readonly companies: CompaniesService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.companies.list(ListCompaniesQuerySchema.parse(query));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.companies.get(id);
  }

  @Patch(':id/favorite')
  setFavorite(@Param('id') id: string, @Body() body: unknown) {
    const { isFavorite } = FavoriteSchema.parse(body);
    return this.companies.setFavorite(id, isFavorite);
  }

  @Post(':id/classify')
  classify(@Param('id') id: string) {
    return this.companies.classify(id);
  }

  @Post('import-crm')
  importCrm(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { companyIds } = ImportCrmSchema.parse(body);
    return this.companies.importCrm(companyIds, user.id);
  }
}

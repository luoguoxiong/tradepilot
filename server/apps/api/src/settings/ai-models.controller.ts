import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { BizException, ErrorCode } from '@tradepilot/core';
import { AiModelsService } from './ai-models.service.js';
import {
  aiModelSelectionSchema,
  createAiModelSchema,
  updateAiModelSchema,
} from './ai-models.dto.js';
import type { AiModelSelectionDto, CreateAiModelDto, UpdateAiModelDto } from './ai-models.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * AI 模型配置接口（接口 16 FR-10 扩展）：
 * - GET/POST/PUT/DELETE /settings/ai-models/catalog：模型台账 CRUD；
 * - PUT /settings/ai-models/catalog/selection：设置某 type 的全局选用模型。
 * 变更仅 admin（03 §4）；读取 admin+manager（settings: view）。
 */
@Controller('settings/ai-models')
export class AiModelsController {
  constructor(@Inject(AiModelsService) private readonly aiModels: AiModelsService) {}

  @Roles('admin', 'manager')
  @Get('catalog')
  async listCatalog(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.aiModels.list(this.requireUser(req).orgId);
  }

  @Roles('admin')
  @Post('catalog')
  async createCatalogModel(
    @Body(new ZodValidationPipe(createAiModelSchema)) dto: CreateAiModelDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.aiModels.create(user.orgId, user.sub, dto);
  }

  // 注意：selection 为静态段，需先于 :id 声明，避免被动态参数吞掉
  @Roles('admin')
  @Put('catalog/selection')
  async selectCatalogModel(
    @Body(new ZodValidationPipe(aiModelSelectionSchema)) dto: AiModelSelectionDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.aiModels.select(this.requireUser(req).orgId, dto);
  }

  @Roles('admin')
  @Put('catalog/:id')
  async updateCatalogModel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAiModelSchema)) dto: UpdateAiModelDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.aiModels.update(this.requireUser(req).orgId, id, dto);
  }

  @Roles('admin')
  @Delete('catalog/:id')
  async removeCatalogModel(
    @Param('id') id: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.aiModels.remove(this.requireUser(req).orgId, id);
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '未认证或登录已失效');
    }
    return user;
  }
}

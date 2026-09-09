import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { paginationQuerySchema } from '@tradepilot/shared';
import { BizException } from '@tradepilot/core';
import { KnowledgeService } from './knowledge.service.js';
import {
  knowledgeSearchSchema,
  listKnowledgeQuerySchema,
  uploadKnowledgeSchema,
  type KnowledgeSearchDto,
  type ListKnowledgeQuery,
  type UploadKnowledgeDto,
} from './knowledge.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 知识中心接口（接口 11 §2，P0）：
 * GET/POST /knowledge/documents、GET/DELETE /documents/{id}、POST /documents/{id}/retry、
 * GET /knowledge/stats、POST /knowledge/search。
 * 权限（11 §7.3）：检索/引用/上传 = 全员；删除/重试 = 仅 manager/administrator（40301）。
 */
@Controller('knowledge')
export class KnowledgeController {
  constructor(@Inject(KnowledgeService) private readonly knowledge: KnowledgeService) {}

  /** 11 §3.1 上传知识（multipart：file + category + source；索引异步执行） */
  @Post('documents')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(uploadKnowledgeSchema)) dto: UploadKnowledgeDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    if (!file) {
      throw BizException.badRequest('缺少上传文件（multipart 字段名 file）');
    }
    return this.knowledge.upload(user.orgId, user.sub, file, dto);
  }

  /** 11 §2 文档列表（category/keyword，过滤已删） */
  @Get('documents')
  async list(
    @Query(new ZodValidationPipe(listKnowledgeQuerySchema.merge(paginationQuerySchema)))
    query: ListKnowledgeQuery & { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.knowledge.list(this.requireUser(req).orgId, query);
  }

  /** 11 §3.5 引用解析（含软删留痕回溯） */
  @Get('documents/:id')
  async detail(@Param('id') docId: string, @Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.knowledge.detail(this.requireUser(req).orgId, docId);
  }

  /** 11 §3.4 删除知识（软删留痕 + chunk 物理清除；仅 manager/administrator） */
  @Delete('documents/:id')
  @Roles('admin', 'manager')
  async remove(@Param('id') docId: string, @Req() req: Request & { authUser?: AccessTokenPayload }) {
    const user = this.requireUser(req);
    return this.knowledge.remove(user.orgId, user.sub, docId);
  }

  /** 11 §3.2 失败重试索引（仅 manager/administrator） */
  @Post('documents/:id/retry')
  @Roles('admin', 'manager')
  async retry(@Param('id') docId: string, @Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.knowledge.retry(this.requireUser(req).orgId, docId);
  }

  /** 11 §1.2 知识统计 */
  @Get('stats')
  async stats(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.knowledge.stats(this.requireUser(req).orgId);
  }

  /** 11 §3.3 RAG 检索（对内 API；noResult=true 时调用方必须显式提示，禁止编造） */
  @Post('search')
  async search(
    @Body(new ZodValidationPipe(knowledgeSearchSchema)) dto: KnowledgeSearchDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.knowledge.search(this.requireUser(req).orgId, dto);
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new Error('未认证（JwtAuthGuard 缺失）');
    }
    return user;
  }
}

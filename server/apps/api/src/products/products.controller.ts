import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { paginationQuerySchema } from '@tradepilot/shared';
import { BizException } from '@tradepilot/core';
import { ProductsService } from './products.service.js';
import {
  createProductSchema,
  listProductsQuerySchema,
  productKnowledgeRequestSchema,
  updateProductSchema,
  uploadProductDocumentSchema,
  type CreateProductDto,
  type ListProductsQuery,
  type ProductKnowledgeRequestDto,
  type UpdateProductDto,
  type UploadProductDocumentDto,
} from './products.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * 产品中心接口（接口 08 §2/§3，P1）：
 * GET/POST /products、GET/PUT /products/{id}、
 * POST /products/{id}/analyze、POST /products/{id}/knowledge/generate|confirm、
 * POST/DELETE /products/{id}/documents[/{fileId}]。
 * 权限（08 §7 未特别限定）：读取/新增/编辑/AI = 全员；资料删除/知识确认 = manager/administrator。
 */
@Controller('products')
export class ProductsController {
  constructor(@Inject(ProductsService) private readonly products: ProductsService) {}

  /** 08 §2 产品列表（keyword=名称/SKU，category/status 过滤，分页） */
  @Get()
  async list(
    @Query(new ZodValidationPipe(listProductsQuerySchema.merge(paginationQuerySchema)))
    query: ListProductsQuery & { page: number; pageSize: number; keyword?: string },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.products.list(this.requireUser(req).orgId, query);
  }

  /** 08 §3.1 新增产品（响应 { productId }；SKU 重复 → 42201） */
  @Post()
  async create(
    @Body(new ZodValidationPipe(createProductSchema)) dto: CreateProductDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.products.create(user.orgId, user.sub, dto);
  }

  /** 08 §1.2~§1.6 产品详情（五个页签全量字段） */
  @Get(':id')
  async detail(
    @Param('id') productId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.products.detail(this.requireUser(req).orgId, productId);
  }

  /** 08 §3.3 编辑产品 */
  @Put(':id')
  async update(
    @Param('id') productId: string,
    @Body(new ZodValidationPipe(updateProductSchema)) dto: UpdateProductDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.products.update(user.orgId, user.sub, productId, dto);
  }

  /** 08 §3.3 AI 分析产品（仅预览，不落库、不改产品基础字段） */
  @Post(':id/analyze')
  async analyze(
    @Param('id') productId: string,
    @Body(new ZodValidationPipe(productKnowledgeRequestSchema)) dto: ProductKnowledgeRequestDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.products.analyze(user.orgId, user.sub, productId, dto);
  }

  /** 08 §3.2 AI 生成产品知识（落 product_knowledge status=draft） */
  @Post(':id/knowledge/generate')
  async generateKnowledge(
    @Param('id') productId: string,
    @Body(new ZodValidationPipe(productKnowledgeRequestSchema)) dto: ProductKnowledgeRequestDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.products.generateKnowledge(user.orgId, user.sub, productId, dto);
  }

  /** 08 §3.2 人工确认启用（draft → approved；仅 manager/administrator） */
  @Post(':id/knowledge/confirm')
  @Roles('admin', 'manager')
  async confirmKnowledge(
    @Param('id') productId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.products.confirmKnowledge(user.orgId, user.sub, productId);
  }

  /** 08 §1.5/§4 上传产品资料（multipart：file + docType；自动归档知识中心并索引） */
  @Post(':id/documents')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(
    @Param('id') productId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(uploadProductDocumentSchema)) dto: UploadProductDocumentDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    if (!file) {
      throw BizException.badRequest('缺少上传文件（multipart 字段名 file）');
    }
    return this.products.uploadDocument(user.orgId, user.sub, productId, file, dto);
  }

  /** 08 §2 删除产品资料（级联软删知识文档 + 清除 chunk；仅 manager/administrator） */
  @Delete(':id/documents/:fileId')
  @Roles('admin', 'manager')
  async removeDocument(
    @Param('id') productId: string,
    @Param('fileId') fileId: string,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    const user = this.requireUser(req);
    return this.products.removeDocument(user.orgId, user.sub, productId, fileId);
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new Error('未认证（JwtAuthGuard 缺失）');
    }
    return user;
  }
}

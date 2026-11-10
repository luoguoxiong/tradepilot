import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreateProductInput, UpdateProductInput } from './products.schemas';

@Injectable()
export class ProductsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 归属校验：只允许操作自己的产品（A01 IDOR） */
  private async getOwned(id: string, userId: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product || product.userId !== userId) {
      throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
    }
    return product;
  }

  list(userId: string) {
    return this.prisma.product.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string, userId: string) {
    return this.getOwned(id, userId);
  }

  create(userId: string, input: CreateProductInput) {
    return this.prisma.product.create({ data: { ...input, userId } });
  }

  async update(id: string, userId: string, input: UpdateProductInput) {
    await this.getOwned(id, userId);
    return this.prisma.product.update({ where: { id }, data: input });
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.getOwned(id, userId);
    await this.prisma.product.delete({ where: { id } });
  }
}

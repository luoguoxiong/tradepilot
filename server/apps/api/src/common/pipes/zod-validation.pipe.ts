import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { BizException } from '@tradepilot/core';

/**
 * Zod 校验管道（01 §4.3）：DTO 即 @tradepilot/shared contracts 中的 Zod schema，
 * 失败 → 40001 + 字段级 detail（extra.issues）。
 *
 * 用法：@Body(new ZodValidationPipe(createCustomerSchema))
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      }));
      throw new BizException(40001, '参数错误', { issues });
    }
    return result.data;
  }
}

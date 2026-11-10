import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger';

/** 全后端唯一错误结构：{ error: { code, message, details? } }（architecture.md §3.3） */
interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.format(exception);
    if (status >= 500) {
      logger.error({ err: exception, status, code: body.error.code }, body.error.message);
    } else {
      logger.warn({ status, code: body.error.code }, body.error.message);
    }
    res.status(status).json(body);
  }

  private format(exception: unknown): { status: number; body: ApiErrorBody } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const rawMessage =
        typeof response === 'string'
          ? response
          : ((response as { message?: unknown }).message ?? exception.message);
      const message = Array.isArray(rawMessage)
        ? rawMessage.map(String).join('; ')
        : String(rawMessage);
      const code =
        typeof response === 'object' &&
        response !== null &&
        typeof (response as { code?: unknown }).code === 'string'
          ? (response as { code: string }).code
          : reasonFor(status);
      return { status, body: { error: { code, message } } };
    }

    if (exception instanceof ZodError) {
      return {
        status: 422,
        body: {
          error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: exception.flatten() },
        },
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          status: 409,
          body: { error: { code: 'CONFLICT', message: 'Duplicate record violates a unique constraint' } },
        };
      }
      if (exception.code === 'P2025') {
        return {
          status: 404,
          body: { error: { code: 'NOT_FOUND', message: 'Record not found' } },
        };
      }
    }

    // 未知异常：不向客户端泄露内部细节
    return {
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    };
  }
}

function reasonFor(status: number): string {
  const name = (HttpStatus as Record<number, string | undefined>)[status];
  return name ?? 'HTTP_ERROR';
}

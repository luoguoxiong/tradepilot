import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.service';
import { LeadScoringService } from './scoring/lead-scoring.service';
import { EmailGenerationService } from './email/email-generation.service';

const IdParamsSchema = z.object({ id: z.string().min(1) });
const DraftParamsSchema = z.object({ draftId: z.string().min(1) });
const GenerateEmailSchema = z.object({ contactId: z.string().min(1).nullish() });
const UpdateDraftSchema = z
  .object({
    subject: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(8000).optional(),
    followUp1: z.string().max(8000).optional(),
    followUp2: z.string().max(8000).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'at least one field required' });

/** AI 端点挂在 companies 资源下（architecture.md §3.3） */
@Controller('companies')
export class AiController {
  constructor(
    @Inject(LeadScoringService) private readonly scoring: LeadScoringService,
    @Inject(EmailGenerationService) private readonly email: EmailGenerationService,
  ) {}

  /** 触发 AI 匹配评分（支持重跑，历史保留） */
  @Post(':id/lead-scores')
  @HttpCode(HttpStatus.CREATED)
  score(@Param() params: unknown, @CurrentUser() user: AuthUser) {
    const { id } = IdParamsSchema.parse(params);
    return this.scoring.score(id, user.id);
  }

  /** 评分历史 */
  @Get(':id/lead-scores')
  scoreHistory(@Param() params: unknown) {
    const { id } = IdParamsSchema.parse(params);
    return this.scoring.history(id);
  }

  /** 生成开发信草稿（重新生成 = 再次 POST，新增一条草稿） */
  @Post(':id/email-drafts')
  @HttpCode(HttpStatus.CREATED)
  generateEmail(@Param() params: unknown, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { id } = IdParamsSchema.parse(params);
    const { contactId } = GenerateEmailSchema.parse(body ?? {});
    return this.email.generate(id, user.id, contactId ?? null);
  }

  @Get(':id/email-drafts')
  listEmails(@Param() params: unknown) {
    const { id } = IdParamsSchema.parse(params);
    return this.email.list(id);
  }

  /** 编辑草稿（保存） */
  @Patch('email-drafts/:draftId')
  updateEmail(@Param() params: unknown, @Body() body: unknown) {
    const { draftId } = DraftParamsSchema.parse(params);
    const input = UpdateDraftSchema.parse(body);
    return this.email.update(draftId, input);
  }
}

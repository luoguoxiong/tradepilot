import { Module } from '@nestjs/common';

import { AiController } from './ai.controller';
import { EmailGenerationService } from './email/email-generation.service';
import { LeadScoringService } from './scoring/lead-scoring.service';

@Module({
  controllers: [AiController],
  providers: [LeadScoringService, EmailGenerationService],
  exports: [LeadScoringService, EmailGenerationService],
})
export class AiModule {}

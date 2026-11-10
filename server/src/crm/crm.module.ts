import { Module } from '@nestjs/common';

import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { CsvService } from './csv.service';

@Module({
  controllers: [CrmController],
  providers: [CrmService, CsvService],
  exports: [CrmService, CsvService],
})
export class CrmModule {}

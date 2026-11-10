import { Module } from '@nestjs/common';

import { AdaptersModule } from '../adapters/adapters.module';
import { CustomsController } from './customs.controller';
import { CustomsService } from './customs.service';

@Module({
  imports: [AdaptersModule],
  controllers: [CustomsController],
  providers: [CustomsService],
  exports: [CustomsService],
})
export class CustomsModule {}

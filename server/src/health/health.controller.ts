import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/guards/jwt-auth.guard';
import { HealthService } from './health.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** GET /api/health —— 验收门：200 且包含数据库连通状态；DB down 时 503 */
  @Get()
  async check() {
    const report = await this.health.check();
    if (report.status === 'error') {
      throw new ServiceUnavailableException({ code: 'DB_UNAVAILABLE', ...report });
    }
    return report;
  }
}

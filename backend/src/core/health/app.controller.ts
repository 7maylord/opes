import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { AppService } from './app.service';
import type { HealthResponse } from './app.service';
import { DatabaseService } from '../database/database.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly database: DatabaseService,
  ) {}

  @Get()
  getRoot(): HealthResponse {
    return this.appService.getHealth();
  }

  @Get('health')
  getHealth(): HealthResponse {
    return this.appService.getHealth();
  }

  @Get('ready')
  async getReadiness(): Promise<{ status: 'ready'; database: 'ok' }> {
    try {
      await this.database.withDatabase((database) =>
        database.query('SELECT 1'),
      );
      return { status: 'ready', database: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }
}

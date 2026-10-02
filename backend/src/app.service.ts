import { Injectable } from '@nestjs/common';
import { loadRuntimeConfig } from './runtime.config';

export interface HealthResponse {
  status: 'ok';
  service: 'opes-backend';
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
}

@Injectable()
export class AppService {
  private readonly startedAt = Date.now();
  private readonly config = loadRuntimeConfig();

  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'opes-backend',
      environment: this.config.environment,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }
}

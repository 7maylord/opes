import {
  Controller,
  Get,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from '../../core/auth/auth-header';
import { OperationsService, OutboxQueueSummary } from './operations.service';

@Controller('operations')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get('outbox')
  async getOutboxSummary(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<{ queues: OutboxQueueSummary[] }> {
    assertOperationsToken(authorization);
    return { queues: await this.operations.getOutboxSummary() };
  }
}

function assertOperationsToken(authorization: string | undefined): void {
  const expected = process.env.OPES_OPERATIONS_TOKEN?.trim();
  if (expected === undefined || expected === '') {
    throw new UnauthorizedException('Operations token is not configured');
  }
  if (parseBearerToken(authorization) !== expected) {
    throw new UnauthorizedException('Operations token is invalid');
  }
}

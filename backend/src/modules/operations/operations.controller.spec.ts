import { UnauthorizedException } from '@nestjs/common';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';

describe('OperationsController', () => {
  const originalToken = process.env.OPES_OPERATIONS_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.OPES_OPERATIONS_TOKEN;
    } else {
      process.env.OPES_OPERATIONS_TOKEN = originalToken;
    }
  });

  it('requires the operations bearer token', async () => {
    process.env.OPES_OPERATIONS_TOKEN = 'secret';
    const controller = new OperationsController({
      getOutboxSummary: jest.fn(),
    } as unknown as OperationsService);

    await expect(controller.getOutboxSummary('Bearer wrong')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('returns outbox queues for authorized operators', async () => {
    process.env.OPES_OPERATIONS_TOKEN = 'secret';
    const controller = new OperationsController({
      getOutboxSummary: jest.fn().mockResolvedValue([{ eventType: 'x' }]),
    } as unknown as OperationsService);

    await expect(controller.getOutboxSummary('Bearer secret')).resolves.toEqual(
      {
        queues: [{ eventType: 'x' }],
      },
    );
  });
});

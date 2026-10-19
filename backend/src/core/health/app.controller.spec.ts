import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from '../database/database.service';

describe('AppController', () => {
  let appController: AppController;
  const withDatabase = jest.fn();

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: DatabaseService, useValue: { withDatabase } },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  it('reports readiness only after the database responds', async () => {
    withDatabase.mockImplementationOnce(
      (
        work: (database: { query: () => Promise<unknown> }) => Promise<unknown>,
      ) =>
        work({
          query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
        }),
    );

    await expect(appController.getReadiness()).resolves.toEqual({
      status: 'ready',
      database: 'ok',
    });
  });

  describe('health', () => {
    it('returns service health', () => {
      const health = appController.getHealth();

      expect(health.status).toBe('ok');
      expect(health.service).toBe('opes-backend');
      expect(typeof health.environment).toBe('string');
      expect(typeof health.uptimeSeconds).toBe('number');
      expect(typeof health.timestamp).toBe('string');
    });
  });
});

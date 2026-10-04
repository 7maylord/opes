import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  CORRELATION_ID_HEADER,
  useCorrelationIds,
} from './../src/correlation-id';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    useCorrelationIds(app);
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpAdapter().getInstance() as App)
      .get('/health')
      .set(CORRELATION_ID_HEADER, 'request-1')
      .expect(200)
      .expect(CORRELATION_ID_HEADER, 'request-1')
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'ok',
          service: 'opes-backend',
          environment: 'test',
        });
      });
  });

  it('/operations/outbox requires an operations token', () => {
    return request(app.getHttpAdapter().getInstance() as App)
      .get('/operations/outbox')
      .expect(401);
  });

  afterEach(async () => {
    await app.close();
  });
});

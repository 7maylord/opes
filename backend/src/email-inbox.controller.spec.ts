import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { EmailInboxController } from './email-inbox.controller';
import { EmailInboxService } from './email-inbox.service';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

describe('email inbox HTTP response', () => {
  let app: INestApplication;
  const getInbox = jest.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [EmailInboxController],
      providers: [
        { provide: EmailInboxService, useValue: { getInbox } },
        {
          provide: SessionService,
          useValue: { resolveUser: () => Promise.resolve({ id: 'user-1' }) },
        },
        {
          provide: TenantContextService,
          useValue: {
            resolve: () => Promise.resolve({ organizationId: 'org-1' }),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    null,
    { id: 'inbox-1', address: 'invoices@example.com', status: 'ACTIVE' },
  ])(
    'returns parseable JSON so unconfigured workspaces can open the inbox: %j',
    async (inbox) => {
      getInbox.mockResolvedValue(inbox);
      const response = await request(app.getHttpServer() as App)
        .get('/organizations/org-1/email-inbox')
        .set('Authorization', 'Bearer session-token')
        .expect(200)
        .expect('Content-Type', /application\/json/);
      expect(response.text).toBe(JSON.stringify(inbox));
      expect(getInbox).toHaveBeenLastCalledWith({ organizationId: 'org-1' });
    },
  );
});

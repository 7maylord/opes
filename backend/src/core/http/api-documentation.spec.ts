import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApiDocumentation } from './api-documentation';

@Controller('health')
class TestHealthController {
  @Get()
  getHealth() {
    return { status: 'ok' };
  }
}

describe('API documentation', () => {
  it('serves an OpenAPI document with classified security', async () => {
    const module = await Test.createTestingModule({
      controllers: [TestHealthController],
    }).compile();
    const app = module.createNestApplication();
    const document = configureApiDocumentation(app);
    await app.init();

    expect(document.paths['/health']?.get).toMatchObject({
      tags: ['Health'],
      security: [],
    });
    expect(Object.keys(document.components?.securitySchemes ?? {})).toEqual(
      expect.arrayContaining(['opesSession', 'privyToken', 'operationsToken']),
    );
    await app.close();
  });
});

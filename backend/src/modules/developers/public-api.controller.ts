import { Controller, Get, Headers, Param } from '@nestjs/common';
import { DeveloperPlatformService } from './developer-platform.service';
@Controller('v1/organizations/:organizationId')
export class PublicApiController {
  constructor(private readonly platform: DeveloperPlatformService) {}
  @Get('invoices') invoices(
    @Param('organizationId') organizationId: string,
    @Headers('x-opes-api-key') apiKey?: string,
  ) {
    return this.platform.publicInvoices(organizationId, apiKey);
  }
  @Get('payments') payments(
    @Param('organizationId') organizationId: string,
    @Headers('x-opes-api-key') apiKey?: string,
  ) {
    return this.platform.publicPayments(organizationId, apiKey);
  }
}

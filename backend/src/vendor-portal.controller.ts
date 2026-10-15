import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from './auth-header';
import { resolveCorrelationId } from './correlation-id';
import { InitiateDocumentUploadRequest } from './document-storage.service';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';
import { VendorPortalService } from './vendor-portal.service';

@Controller('organizations/:organizationId/vendors/:vendorId/portal-access')
export class VendorPortalAdminController {
  constructor(
    private readonly portal: VendorPortalService,
    private readonly sessions: SessionService,
    private readonly contexts: TenantContextService,
  ) {}

  @Post()
  async create(
    @Param('organizationId') organizationId: string,
    @Param('vendorId') vendorId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: { contactEmail: string; expiresAt: string },
  ) {
    return this.portal.createAccess(
      await this.context(organizationId, authorization, correlationId),
      vendorId,
      body,
    );
  }

  @Delete(':accessId')
  async revoke(
    @Param('organizationId') organizationId: string,
    @Param('accessId') accessId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    return this.portal.revokeAccess(
      await this.context(organizationId, authorization, correlationId),
      accessId,
    );
  }

  private async context(
    organizationId: string,
    authorization?: string,
    correlationId?: string,
  ) {
    const token = parseBearerToken(authorization);
    const user = token ? await this.sessions.resolveUser(token) : null;
    if (!user)
      throw new UnauthorizedException('Valid bearer session is required');
    return this.contexts.resolve({
      organizationId,
      userId: user.id,
      requestId: resolveCorrelationId(correlationId),
    });
  }
}

@Controller('vendor-portal/:token')
export class VendorPortalController {
  constructor(private readonly portal: VendorPortalService) {}

  @Get()
  getPortal(@Param('token') token: string) {
    return this.portal.getPortal(token);
  }

  @Get('submissions')
  list(@Param('token') token: string) {
    return this.portal.listSubmissions(token);
  }

  @Post('submissions/uploads')
  initiate(
    @Param('token') token: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body()
    body: InitiateDocumentUploadRequest & {
      vendorNote?: string;
      replacesSubmissionId?: string;
    },
  ) {
    return this.portal.initiateSubmission(token, key, body);
  }

  @Post('submissions/:submissionId/finalize')
  finalize(
    @Param('token') token: string,
    @Param('submissionId') submissionId: string,
  ) {
    return this.portal.finalizeSubmission(token, submissionId);
  }
}

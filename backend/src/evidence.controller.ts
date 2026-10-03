import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from './auth-header';
import { resolveCorrelationId } from './correlation-id';
import { EvidenceService } from './evidence.service';
import type {
  CreateVendorAddressRequest,
  CreateVendorRequest,
  DocumentExtractionResponse,
  EvidenceDocumentResponse,
  RecordDocumentExtractionRequest,
  RecordEvidenceDocumentRequest,
  VendorAddressResponse,
  VendorResponse,
} from './evidence.service';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

@Controller('organizations/:organizationId')
export class EvidenceController {
  constructor(
    private readonly evidence: EvidenceService,
    private readonly sessions: SessionService,
    private readonly tenantContexts: TenantContextService,
  ) {}

  @Post('vendors')
  async createVendor(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: CreateVendorRequest,
  ): Promise<VendorResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );

    return this.evidence.createVendor(context, body);
  }

  @Post('vendors/:vendorId/addresses')
  async addVendorAddress(
    @Param('organizationId') organizationId: string,
    @Param('vendorId') vendorId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: CreateVendorAddressRequest,
  ): Promise<VendorAddressResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );

    return this.evidence.addVendorAddress(context, vendorId, body);
  }

  @Post('vendor-addresses/:addressId/verify')
  async verifyVendorAddress(
    @Param('organizationId') organizationId: string,
    @Param('addressId') addressId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<VendorAddressResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );

    return this.evidence.verifyVendorAddress(context, addressId);
  }

  @Post('evidence-documents')
  async recordEvidenceDocument(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: RecordEvidenceDocumentRequest,
  ): Promise<EvidenceDocumentResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );

    return this.evidence.recordEvidenceDocument(context, body);
  }

  @Post('evidence-documents/:documentId/extractions')
  async recordDocumentExtraction(
    @Param('organizationId') organizationId: string,
    @Param('documentId') documentId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: RecordDocumentExtractionRequest,
  ): Promise<DocumentExtractionResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );

    return this.evidence.recordDocumentExtraction(context, documentId, body);
  }

  private async resolveContext(
    organizationId: string,
    authorization: string | undefined,
    correlationId: string | undefined,
  ) {
    const token = parseBearerToken(authorization);
    if (token === undefined) {
      throw new UnauthorizedException('Bearer session token is required');
    }

    const user = await this.sessions.resolveUser(token);
    if (user === null) {
      throw new UnauthorizedException('Session is invalid or expired');
    }

    return this.tenantContexts.resolve({
      organizationId,
      userId: user.id,
      requestId: resolveCorrelationId(correlationId),
    });
  }
}

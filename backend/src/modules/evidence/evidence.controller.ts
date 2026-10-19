import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from '../../core/auth/auth-header';
import { resolveCorrelationId } from '../../core/http/correlation-id';
import { DocumentExtractionService } from './document-extraction.service';
import { EvidenceService } from './evidence.service';
import type {
  CreateVendorAddressRequest,
  CreateVendorRequest,
  VendorAddressResponse,
  VendorResponse,
} from './evidence.service';
import { DocumentStorageService } from './document-storage.service';
import type {
  InitiateDocumentUploadRequest,
  InitiateDocumentUploadResponse,
} from './document-storage.service';
import type { EvidenceDocumentResponse } from './evidence.service';
import type { DocumentExtractionResponse } from './evidence.service';
import type {
  ConfirmDocumentClaimsRequest,
  DocumentClaimResponse,
} from './evidence.service';
import { SessionService } from '../../core/auth/session.service';
import { TenantContextService } from '../../core/database/tenant-context.service';

@Controller('organizations/:organizationId')
export class EvidenceController {
  constructor(
    private readonly evidence: EvidenceService,
    private readonly documents: DocumentStorageService,
    private readonly extractions: DocumentExtractionService,
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

  @Post('evidence-documents/uploads')
  async initiateDocumentUpload(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: InitiateDocumentUploadRequest,
  ): Promise<InitiateDocumentUploadResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );

    return this.documents.initiateUpload(context, body);
  }

  @Post('evidence-documents/:documentId/finalize')
  async finalizeDocumentUpload(
    @Param('organizationId') organizationId: string,
    @Param('documentId') documentId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<EvidenceDocumentResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );

    return this.documents.finalizeUpload(context, documentId);
  }

  @Get('evidence-documents/:documentId/download')
  async downloadDocument(
    @Param('organizationId') organizationId: string,
    @Param('documentId') documentId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<{ url: string; expiresAt: string }> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.documents.createDownload(context, documentId);
  }

  @Post('evidence-documents/:documentId/extract')
  async extractInvoiceDocument(
    @Param('organizationId') organizationId: string,
    @Param('documentId') documentId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<DocumentExtractionResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.extractions.extractInvoice(context, documentId);
  }

  @Post('evidence-documents/:documentId/extractions/:extractionId/confirm')
  async confirmDocumentClaims(
    @Param('organizationId') organizationId: string,
    @Param('documentId') documentId: string,
    @Param('extractionId') extractionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: ConfirmDocumentClaimsRequest,
  ): Promise<DocumentClaimResponse> {
    const context = await this.resolveContext(
      organizationId,
      authorization,
      correlationId,
    );
    return this.evidence.confirmDocumentClaims(
      context,
      documentId,
      extractionId,
      body,
    );
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

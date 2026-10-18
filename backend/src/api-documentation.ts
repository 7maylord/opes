import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';

const tags: Array<[string, string]> = [
  ['Health', 'Service liveness and database readiness'],
  ['Authentication', 'Privy token exchange and OPES sessions'],
  ['Organizations', 'Onboarding, organizations, members, and invitations'],
  ['Agent setup', 'Business agent state and Arc resource provisioning'],
  ['Evidence', 'Vendors, documents, extraction, and procurement evidence'],
  [
    'Invoices and decisions',
    'Invoice verification, decisions, overrides, and execution',
  ],
  ['Agreements', 'Recurring mandates and milestone escrow'],
  ['Treasury', 'Treasury position, owner controls, liquidity, and ledger'],
  ['Inbox and integrations', 'Email, vendor portal, and accounting connectors'],
  ['Notifications', 'Workspace notifications and read state'],
  ['Workspace audit', 'Tenant-scoped records, history, and lineage'],
  ['Operations', 'Protected operational queue visibility'],
  ['Provider webhooks', 'Signed provider callbacks'],
];
const httpMethods = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
] as const;

export function configureApiDocumentation(
  app: INestApplication,
): OpenAPIObject {
  let builder = new DocumentBuilder()
    .setTitle('OPES API')
    .setDescription(
      'Evidence intake, treasury authorization, agreement management, USDC execution, reconciliation, and audit APIs for OPES workspaces.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'OPES session token' },
      'opesSession',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'Privy access token' },
      'privyToken',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'Operations token' },
      'operationsToken',
    );
  for (const [name, description] of tags)
    builder = builder.addTag(name, description);

  const document = SwaggerModule.createDocument(app, builder.build(), {
    deepScanRoutes: true,
    operationIdFactory: (controller, method) =>
      `${controller.replace(/Controller$/, '')}_${method}`,
  });
  applyApiDocumentationConventions(document);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: '/docs/openapi.json',
    customSiteTitle: 'OPES API documentation',
    swaggerOptions: {
      displayRequestDuration: true,
      filter: true,
      persistAuthorization: true,
      tryItOutEnabled: true,
    },
  });
  return document;
}

export function applyApiDocumentationConventions(
  document: OpenAPIObject,
): void {
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of httpMethods) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      operation.tags = [tagForPath(path)];
      operation.security = securityForPath(path);
    }
  }
}

function securityForPath(path: string): Array<Record<string, string[]>> {
  if (path === '/auth/privy/session') return [{ privyToken: [] }];
  if (path.startsWith('/operations/')) return [{ operationsToken: [] }];
  if (
    ['/', '/health', '/ready'].includes(path) ||
    path.startsWith('/webhooks/') ||
    path.includes('/payment-webhooks/') ||
    path.startsWith('/vendor-portal/')
  )
    return [];
  return [{ opesSession: [] }];
}

function tagForPath(path: string): string {
  if (['/', '/health', '/ready'].includes(path)) return 'Health';
  if (path.startsWith('/auth/') || path === '/session') return 'Authentication';
  if (
    path === '/onboarding' ||
    (path.startsWith('/organizations') &&
      !path.includes('/workspace') &&
      !path.includes('/agent') &&
      !path.includes('/vendors') &&
      !path.includes('/vendor-') &&
      !path.includes('/evidence') &&
      !path.includes('/procurement') &&
      !path.includes('/invoice') &&
      !path.includes('/decision') &&
      !path.includes('/subscription') &&
      !path.includes('/escrow') &&
      !path.includes('/treasury') &&
      !path.includes('/liquidity') &&
      !path.includes('/ledger') &&
      !path.includes('/email-inbox') &&
      !path.includes('/accounting-connectors') &&
      !path.includes('/notifications'))
  )
    return 'Organizations';
  if (path.includes('/agent')) return 'Agent setup';
  if (
    path.includes('/vendors') ||
    path.includes('/vendor-addresses') ||
    path.includes('/evidence') ||
    path.includes('/procurement')
  )
    return 'Evidence';
  if (path.includes('/invoice') || path.includes('/decision'))
    return 'Invoices and decisions';
  if (path.includes('/subscription') || path.includes('/escrow'))
    return 'Agreements';
  if (
    path.includes('/treasury') ||
    path.includes('/liquidity') ||
    path.includes('/ledger') ||
    path.includes('/payment-executions')
  )
    return 'Treasury';
  if (
    path.includes('/email-inbox') ||
    path.includes('/accounting-connectors') ||
    path.includes('/vendor-portal')
  )
    return 'Inbox and integrations';
  if (path.includes('/notifications')) return 'Notifications';
  if (path.includes('/workspace')) return 'Workspace audit';
  if (path.startsWith('/operations/')) return 'Operations';
  if (path.startsWith('/webhooks/') || path.includes('/payment-webhooks/'))
    return 'Provider webhooks';
  return 'Organizations';
}

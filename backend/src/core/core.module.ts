import { Global, Module } from '@nestjs/common';
import { AppController } from './health/app.controller';
import { AppService } from './health/app.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { SessionController } from './auth/session.controller';
import { SessionService } from './auth/session.service';
import { DatabaseService } from './database/database.service';
import { TenantContextService } from './database/tenant-context.service';

@Global()
@Module({
  controllers: [AppController, AuthController, SessionController],
  providers: [
    AppService,
    AuthService,
    SessionService,
    DatabaseService,
    TenantContextService,
  ],
  exports: [SessionService, DatabaseService, TenantContextService],
})
export class CoreModule {}

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database.service';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

@Module({
  imports: [],
  controllers: [AppController, SessionController],
  providers: [
    AppService,
    DatabaseService,
    SessionService,
    TenantContextService,
  ],
})
export class AppModule {}

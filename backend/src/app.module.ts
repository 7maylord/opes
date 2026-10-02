import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database.service';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [
    AppService,
    DatabaseService,
    SessionService,
    TenantContextService,
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database.service';
import { TenantContextService } from './tenant-context.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, DatabaseService, TenantContextService],
})
export class AppModule {}

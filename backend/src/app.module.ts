import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database.service';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

@Module({
  imports: [],
  controllers: [AppController, OnboardingController, SessionController],
  providers: [
    AppService,
    DatabaseService,
    OnboardingService,
    SessionService,
    TenantContextService,
  ],
})
export class AppModule {}

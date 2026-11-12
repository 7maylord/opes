import { Module } from '@nestjs/common';
import { AgreementsModule } from '../agreements/agreements.module';
import { LiquidityController } from './liquidity.controller';
import { LiquidityExecutionWorkerService } from './liquidity-execution-worker.service';
import { LiquidityService } from './liquidity.service';
import { OwnerTreasuryController } from './owner-treasury.controller';
import { OwnerTreasuryService } from './owner-treasury.service';
import { TreasuryReconciliationService } from './treasury-reconciliation.service';
import { PaymentCalendarController } from './payment-calendar.controller';
import { PaymentCalendarService } from './payment-calendar.service';

@Module({
  imports: [AgreementsModule],
  controllers: [
    LiquidityController,
    OwnerTreasuryController,
    PaymentCalendarController,
  ],
  providers: [
    LiquidityService,
    LiquidityExecutionWorkerService,
    OwnerTreasuryService,
    TreasuryReconciliationService,
    PaymentCalendarService,
  ],
  exports: [
    LiquidityService,
    LiquidityExecutionWorkerService,
    OwnerTreasuryService,
    TreasuryReconciliationService,
  ],
})
export class TreasuryModule {}

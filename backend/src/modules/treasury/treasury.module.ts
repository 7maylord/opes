import { Module } from '@nestjs/common';
import { AgreementsModule } from '../agreements/agreements.module';
import { LiquidityController } from './liquidity.controller';
import { LiquidityExecutionWorkerService } from './liquidity-execution-worker.service';
import { LiquidityService } from './liquidity.service';
import { OwnerTreasuryController } from './owner-treasury.controller';
import { OwnerTreasuryService } from './owner-treasury.service';
import { TreasuryReconciliationService } from './treasury-reconciliation.service';

@Module({
  imports: [AgreementsModule],
  controllers: [LiquidityController, OwnerTreasuryController],
  providers: [
    LiquidityService,
    LiquidityExecutionWorkerService,
    OwnerTreasuryService,
    TreasuryReconciliationService,
  ],
  exports: [
    LiquidityService,
    LiquidityExecutionWorkerService,
    OwnerTreasuryService,
    TreasuryReconciliationService,
  ],
})
export class TreasuryModule {}

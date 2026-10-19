import { Module } from '@nestjs/common';
import { EscrowExecutionService } from './escrow-execution.service';
import { LifecycleController } from './lifecycle.controller';
import { LifecycleService } from './lifecycle.service';
import { RecurringExecutionService } from './recurring-execution.service';

@Module({
  controllers: [LifecycleController],
  providers: [
    LifecycleService,
    RecurringExecutionService,
    EscrowExecutionService,
  ],
  exports: [
    LifecycleService,
    RecurringExecutionService,
    EscrowExecutionService,
  ],
})
export class AgreementsModule {}

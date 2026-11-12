import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { ProvisioningWorkerService } from './provisioning-worker.service';

@Module({
  controllers: [AgentController],
  providers: [AgentService, ProvisioningWorkerService],
  exports: [ProvisioningWorkerService],
})
export class AgentsModule {}

import { Module } from '@nestjs/common';
import { ExceptionCenterController } from './exception-center.controller';
import { ExceptionCenterService } from './exception-center.service';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';

@Module({
  controllers: [OperationsController, ExceptionCenterController],
  providers: [OperationsService, ExceptionCenterService],
})
export class OperationsModule {}

import { Global, Module } from '@nestjs/common';
import { CircleWalletService } from './circle/circle-wallet.service';
import { FactoryManifestService } from './contracts/factory-manifest.service';
import { RailwayBucketService } from './storage/railway-bucket.service';

@Global()
@Module({
  providers: [
    CircleWalletService,
    FactoryManifestService,
    RailwayBucketService,
  ],
  exports: [CircleWalletService, FactoryManifestService, RailwayBucketService],
})
export class InfrastructureModule {}

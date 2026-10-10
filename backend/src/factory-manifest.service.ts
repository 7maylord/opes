import { Injectable } from '@nestjs/common';
import manifest from './deployments/arc-testnet-factory.json';

export interface VerifiedFactoryManifest {
  environment: string;
  chainId: number;
  factoryAddress: string;
  vaultDeployerAddress: string;
  tokenAddress: string;
  verification: string;
  explorerUrl: string;
  checkedAt: string;
}

interface FactoryManifestFile {
  environment: string;
  chainId: number;
  checkedAt: string;
  token: string;
  contracts: {
    OrganizationFactory: {
      address: string;
      verification: string;
      explorerUrl: string;
    };
    VaultDeployer: {
      address: string;
      verification: string;
    };
  };
}

@Injectable()
export class FactoryManifestService {
  getArcTestnetFactory(): VerifiedFactoryManifest {
    const file = manifest as FactoryManifestFile;

    return {
      environment: file.environment,
      chainId: file.chainId,
      factoryAddress: file.contracts.OrganizationFactory.address,
      vaultDeployerAddress: file.contracts.VaultDeployer.address,
      tokenAddress: file.token,
      verification: file.contracts.OrganizationFactory.verification,
      explorerUrl: file.contracts.OrganizationFactory.explorerUrl,
      checkedAt: file.checkedAt,
    };
  }
}

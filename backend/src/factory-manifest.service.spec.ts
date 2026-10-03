import { FactoryManifestService } from './factory-manifest.service';

describe('FactoryManifestService', () => {
  it('loads the verified Arc testnet factory manifest', () => {
    const manifest = new FactoryManifestService().getArcTestnetFactory();

    expect(manifest).toMatchObject({
      environment: 'arc-testnet',
      chainId: 5042002,
      verification: 'fully_verified',
    });
    expect(manifest.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(manifest.vaultDeployerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});

import { CircleWalletService } from './circle-wallet.service';

const originalApiKey = process.env.CIRCLE_API_KEY;
const originalEntitySecret = process.env.CIRCLE_ENTITY_SECRET;

afterAll(() => {
  if (originalApiKey === undefined) delete process.env.CIRCLE_API_KEY;
  else process.env.CIRCLE_API_KEY = originalApiKey;
  if (originalEntitySecret === undefined)
    delete process.env.CIRCLE_ENTITY_SECRET;
  else process.env.CIRCLE_ENTITY_SECRET = originalEntitySecret;
});

it('lets Circle estimate current Arc fees for direct payments', async () => {
  process.env.CIRCLE_API_KEY = 'test-key';
  process.env.CIRCLE_ENTITY_SECRET = 'test-secret';
  const createContractExecutionTransaction = jest
    .fn()
    .mockResolvedValue({ data: { id: 'transaction-1', state: 'INITIATED' } });
  const service = new CircleWalletService();
  Object.assign(service, {
    client: { createContractExecutionTransaction },
  });

  await service.createDirectPaymentTransaction({
    walletId: 'wallet-1',
    vaultAddress: '0x0000000000000000000000000000000000000001',
    callData: '0x1234',
    executionId: '55555555-5555-4555-8555-555555555555',
  });

  expect(createContractExecutionTransaction).toHaveBeenCalledWith(
    expect.objectContaining({
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    }),
  );
});

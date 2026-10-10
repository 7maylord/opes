import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  CircleDeveloperControlledWalletsClient,
  Transaction,
  WalletsDataWalletsInner,
} from '@circle-fin/developer-controlled-wallets';
import factoryAbi from './abi/OrganizationFactory.json';

const organizationFactoryAbi = factoryAbi as Array<{
  type: string;
  name?: string;
  inputs?: Array<{ type: string }>;
}>;
const createOrganization = organizationFactoryAbi.find(
  (entry) => entry.type === 'function' && entry.name === 'createOrganization',
);
if (!createOrganization?.inputs) {
  throw new Error('OrganizationFactory createOrganization ABI is missing');
}
const createOrganizationSignature = `createOrganization(${createOrganization.inputs
  .map((input) => input.type)
  .join(',')})`;

@Injectable()
export class CircleWalletService {
  private client?: CircleDeveloperControlledWalletsClient;

  isConfigured(): boolean {
    return Boolean(
      process.env.CIRCLE_API_KEY?.trim() &&
      process.env.CIRCLE_ENTITY_SECRET?.trim(),
    );
  }

  async createWalletSet(idempotencyKey: string): Promise<string> {
    const response = await this.getClient().createWalletSet({
      name: 'OPES',
      idempotencyKey,
    });
    const id = response.data?.walletSet.id;
    if (!id) throw new Error('Circle did not return a wallet set');
    return id;
  }

  async findWallet(
    refId: string,
  ): Promise<WalletsDataWalletsInner | undefined> {
    const response = await this.getClient().listWallets({
      blockchain: 'ARC-TESTNET',
      refId,
    });
    const wallets = response.data?.wallets ?? [];
    if (wallets.length > 1) {
      throw new Error(`Circle returned duplicate wallets for ${refId}`);
    }
    return wallets[0];
  }

  async createWallet(input: {
    walletSetId: string;
    refId: string;
    name: string;
    idempotencyKey: string;
  }): Promise<WalletsDataWalletsInner> {
    const response = await this.getClient().createWallets({
      walletSetId: input.walletSetId,
      blockchains: ['ARC-TESTNET'],
      count: 1,
      accountType: 'EOA',
      metadata: [{ name: input.name, refId: input.refId }],
      idempotencyKey: input.idempotencyKey,
    });
    const wallet = response.data?.wallets[0];
    if (!wallet) throw new Error('Circle did not return a wallet');
    return wallet;
  }

  async requestArcTestnetTokens(address: string): Promise<void> {
    await this.getClient().requestTestnetTokens({
      address,
      blockchain: 'ARC-TESTNET',
      usdc: true,
    });
  }

  async createFactoryTransaction(input: {
    walletId: string;
    factoryAddress: string;
    organizationDomain: string;
    owner: string;
    operator: string;
    idempotencyKey: string;
  }): Promise<{ id: string; state: string }> {
    const response = await this.getClient().createContractExecutionTransaction({
      walletId: input.walletId,
      contractAddress: input.factoryAddress,
      abiFunctionSignature: createOrganizationSignature,
      abiParameters: [
        input.organizationDomain,
        input.owner,
        input.operator,
        input.owner,
        input.owner,
      ],
      fee: {
        type: 'absolute',
        config: { maxFee: '50', priorityFee: '0', gasLimit: '6500000' },
      },
      refId: `opes:factory:${input.organizationDomain}`,
      idempotencyKey: input.idempotencyKey,
    });
    const transaction = response.data;
    if (!transaction) throw new Error('Circle did not return a transaction');
    return transaction;
  }

  async getTransaction(id: string): Promise<Transaction> {
    const response = await this.getClient().getTransaction({ id });
    const transaction = response.data?.transaction;
    if (!transaction) throw new Error('Circle transaction was not found');
    return transaction;
  }

  private getClient(): CircleDeveloperControlledWalletsClient {
    const apiKey = process.env.CIRCLE_API_KEY?.trim();
    const entitySecret = process.env.CIRCLE_ENTITY_SECRET?.trim();
    if (!apiKey || !entitySecret) {
      throw new ServiceUnavailableException(
        'Circle wallets are not configured',
      );
    }
    return (this.client ??= new CircleDeveloperControlledWalletsClient({
      apiKey,
      entitySecret,
    }));
  }
}

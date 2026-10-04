import { buildCctpDepositForBurnCalldata } from './cctp-calldata';

describe('buildCctpDepositForBurnCalldata', () => {
  it('builds TokenMessengerV2 depositForBurn calldata', () => {
    const data = buildCctpDepositForBurnCalldata({
      amount: '25000000',
      destinationDomain: 3,
      mintRecipient: '0x0000000000000000000000000000000000000002',
      burnToken: '0x3600000000000000000000000000000000000000',
    });

    expect(data).toMatch(/^0x[0-9a-f]+$/);
    expect(data.slice(0, 10)).toBe('0x8e0250ee');
    expect(data).toContain(
      '00000000000000000000000000000000000000000000000000000000017d7840',
    );
    expect(data).toContain(
      '0000000000000000000000000000000000000000000000000000000000000003',
    );
    expect(data).toContain('0000000000000000000000000000000000000002');
    expect(data).toContain(
      '0000000000000000000000003600000000000000000000000000000000000000',
    );
    expect(
      data.endsWith(
        '00000000000000000000000000000000000000000000000000000000000007d0',
      ),
    ).toBe(true);
  });
});

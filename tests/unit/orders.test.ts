import { describe, expect, it, vi } from 'vitest';
import { fetchOpenOrders, cancelOrRefundOrder } from '@/lib/orders';
import { hexToBin, secp256k1, hash160 } from '@bitauth/libauth';

describe('Orders Management & In-Wallet Cancel', () => {
  it('fetchOpenOrders filters out terminal intents', async () => {
    const mockIntents = [
      { id: '1', status: 'pending', sellAmount: '1000', buyAmount: '2000' },
      { id: '2', status: 'filled', sellAmount: '1000', buyAmount: '2000' },
      { id: '3', status: 'cancelled', sellAmount: '1000', buyAmount: '2000' },
      { id: '4', status: 'active', sellAmount: '5000', buyAmount: '10000' },
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockIntents,
    } as any);

    const open = await fetchOpenOrders('bchtest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqf8rvp5lf', 'chipnet');
    expect(open.length).toBe(2);
    expect(open.map(o => o.id)).toEqual(['1', '4']);
  });

  it('cancelOrRefundOrder constructs and signs cancelEarly when not expired', async () => {
    const makerPriv = hexToBin('22'.repeat(32));
    const makerPub = secp256k1.derivePublicKeyCompressed(makerPriv) as Uint8Array;
    const makerPkh = hash160(makerPub);

    const mockWallet = {
      privateKey: makerPriv,
      getUtxos: vi.fn().mockResolvedValue([
        { txid: 'bb'.repeat(32), vout: 0, satoshis: 10_000n },
      ]),
      provider: {
        getUtxos: vi.fn().mockResolvedValue([
          { txid: 'aa'.repeat(32), vout: 0, satoshis: 50_000n },
        ]),
      },
      submitTransaction: vi.fn().mockResolvedValue('success'),
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as any);

    const order: any = {
      id: 'test-order-1',
      type: 'LIMIT_ORDER',
      contractAddress: 'bchtest:prcontractaddress',
      sellToken: 'BCH',
      buyToken: '0x11'.padEnd(66, '0'),
      sellAmount: '50000',
      buyAmount: '10000',
      refundableFrom: Math.floor(Date.now() / 1000) + 3600, // not expired
      status: 'pending',
    };

    const result = await cancelOrRefundOrder({
      order,
      bchWallet: mockWallet,
      networkMode: 'chipnet',
      userAddress: 'bchtest:maker',
    });

    expect(result.isExpired).toBe(false);
    expect(result.txid).toHaveLength(64);
    expect(mockWallet.submitTransaction).toHaveBeenCalledTimes(1);
  });
});

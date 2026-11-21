/**
 * Test verifying that bch-intents-wallet-extension seamlessly consumes, summarizes,
 * and signs transactions generated from the Mesh XO Limit Order template.
 */
import { describe, expect, it } from 'vitest';
import {
  binToHex,
  createVirtualMachineBch,
  decodeTransaction,
  encodeCashAddress,
  encodeLockingBytecodeP2pkh,
  hash160,
  hexToBin,
  secp256k1,
  stringify,
  type Output,
  type Transaction,
} from '@bitauth/libauth';
import {
  parseSignRequest,
  signTransaction,
  summarizeSignRequest,
  type SignTxRequest,
} from '@/lib/bch-sign';

// Import builders from bch-xo-templates
import {
  buildCancelEarlyTransaction,
  toWalletSignTxRequest,
  getLimitOrderLockingBytecode,
  getLimitOrderAddress,
  type LimitOrderParams,
} from '../../../bch-xo-templates/src/index';

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const makerPriv = hexToBin('11'.repeat(32));
const makerPub = secp256k1.derivePublicKeyCompressed(makerPriv) as Uint8Array;
const makerPkh = hash160(makerPub);
const makerAddress = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: makerPkh }).address;

const CAT = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';

/** Simulates how a dApp sends a sign request over the window.bchIntents RPC boundary */
function wire(request: any) {
  const { transaction, sourceOutputs, ...extra } = request;
  const withOutpoints = sourceOutputs.map((o: any, i: number) => ({
    ...(typeof transaction === 'string' ? {} : transaction.inputs[i]),
    ...o,
  }));
  return [JSON.parse(stringify({ transaction, sourceOutputs: withOutpoints, ...extra }))];
}

describe('Wallet Extension Signing with Mesh XO Limit Order Template', () => {
  const EXPIRY = 1750000000n;
  const orderParams: LimitOrderParams = {
    makerPkh,
    sellTokenCategory: '0x', // selling 50,000 BCH sats
    buyTokenCategory: CAT,   // buying 10,000 PUSD tokens
    sellAmount: 50_000n,
    buyAmount: 10_000n,
    expiryTime: EXPIRY,
  };

  it('wallet summarizes the XO cancelEarly action transparently for the user', () => {
    const orderUtxo = {
      txid: 'aa'.repeat(32),
      vout: 0,
      satoshis: 50_000n,
    };
    const feeUtxo = {
      txid: 'bb'.repeat(32),
      vout: 0,
      satoshis: 10_000n,
    };

    const { transaction, sourceOutputs, redeemScript } = buildCancelEarlyTransaction({
      orderParams,
      orderUtxo,
      feeUtxo,
      makerPk: makerPub,
      makerPkh,
      feePkh: makerPkh,
      feeSatoshis: 1500n,
    });

    const rawPayload = toWalletSignTxRequest({
      transaction,
      sourceOutputs,
      redeemScript,
      userPrompt: 'Cancel Order Early: Return 50,000 sats to Maker',
    });

    const parsed = parseSignRequest(wire(rawPayload));
    expect(typeof parsed).not.toBe('string');
    const req = parsed as SignTxRequest;

    const summary = summarizeSignRequest(req, makerAddress);

    // 1 contract input (covenant refund) + 1 own P2PKH input (fee payment)
    expect(summary.contractInputs).toBe(1);
    expect(summary.ownInputs).toBe(1);

    // Fee calculated correctly: 1,500 satoshis
    expect(summary.fee).toBe(1500n);

    // Outputs returning to maker: 50,000 satoshis from covenant + 8,500 satoshis fee change
    expect(summary.outputs.length).toBe(2);
    expect(summary.outputs[0].address).toBe(makerAddress);
    expect(summary.outputs[0].satoshis).toBe(50_000n);
    expect(summary.outputs[1].address).toBe(makerAddress);
    expect(summary.outputs[1].satoshis).toBe(8_500n);
  });

  it('wallet signs the XO cancelEarly transaction and produces valid BCH VM execution', () => {
    const orderUtxo = {
      txid: 'aa'.repeat(32),
      vout: 0,
      satoshis: 50_000n,
    };
    const feeUtxo = {
      txid: 'bb'.repeat(32),
      vout: 0,
      satoshis: 10_000n,
    };

    const { transaction, sourceOutputs, redeemScript } = buildCancelEarlyTransaction({
      orderParams,
      orderUtxo,
      feeUtxo,
      makerPk: makerPub,
      makerPkh,
      feePkh: makerPkh,
      feeSatoshis: 1500n,
    });

    const rawPayload = toWalletSignTxRequest({
      transaction,
      sourceOutputs,
      redeemScript,
      userPrompt: 'Cancel Order Early: Return 50,000 sats to Maker',
    });

    const req = parseSignRequest(wire(rawPayload)) as SignTxRequest;

    // Use wallet extension's signTransaction directly
    const signed = signTransaction(req, makerPriv);
    expect(signed.hex).toBeTypeOf('string');
    expect(signed.txid.length).toBe(64);

    // Execute the signed transaction on the real Bitcoin Cash Virtual Machine
    const decoded = decodeTransaction(signed.bytes);
    expect(typeof decoded).not.toBe('string');

    const vmResult = createVirtualMachineBch(false).verify({
      sourceOutputs: req.sourceOutputs,
      transaction: decoded as Transaction,
    });

    expect(vmResult).toBe(true);
  });
});

/**
 * orders.ts — Intent & Limit Order management within Cham Wallet extension.
 *
 * Implements:
 *   - Cross-device discovery via Relayer API (fetches active intents for maker)
 *   - In-wallet execution of cancelEarly and cancel (post-expiry refund)
 *   - Semantic template binding powered by bch-xo-templates
 */

import { hash160, secp256k1 } from '@bitauth/libauth';
import {
  buildCancelEarlyTransaction,
  buildCancelTransaction,
  toWalletSignTxRequest,
  type LimitOrderParams,
  type Outpoint,
} from '@bch-xo-templates';
import { signTransaction } from '@/lib/bch-sign';
import { addActivity } from '@/lib/activity';
import { formatAmount, shortAddr } from '@/lib/format';
import { createRelayerApi, TERMINAL_INTENT, type Intent } from '@/swap/cashtoken';

export interface CancelOrderResult {
  txid: string;
  isExpired: boolean;
}

/**
 * Discovers all active / open intents for a given maker address.
 * Cross-device: Queries the indexer/relayer so any imported wallet on any device
 * automatically sees its open orders.
 */
export async function fetchOpenOrders(
  makerAddress: string,
  mode: 'mainnet' | 'chipnet'
): Promise<Intent[]> {
  if (!makerAddress) return [];
  try {
    const relayer = createRelayerApi(mode);
    const intents = await relayer.listIntents(makerAddress, 50);
    return (intents || []).filter(i => !TERMINAL_INTENT.includes(i.status));
  } catch (err: any) {
    console.warn('[Orders] fetchOpenOrders error:', err.message || err);
    return [];
  }
}

/**
 * Cancels or refunds an open Limit Order directly inside the wallet using the user's keys.
 * If active: builds and signs cancelEarly() (maker-authorized).
 * If expired: builds and signs cancel() (permissionless refund).
 */
export async function cancelOrRefundOrder(options: {
  order: Intent;
  bchWallet: any;
  networkMode: 'mainnet' | 'chipnet';
  userAddress: string;
}): Promise<CancelOrderResult> {
  const { order, bchWallet, networkMode, userAddress } = options;

  if (!bchWallet) throw new Error('BCH Wallet is not connected or initialized.');
  const privateKey = bchWallet.privateKey as Uint8Array | undefined;
  if (!privateKey) throw new Error('Private key unavailable — please ensure wallet is unlocked.');

  const makerPk = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof makerPk === 'string') throw new Error(makerPk);
  const makerPkh = hash160(makerPk);

  // 1. Fetch live covenant UTXO from the blockchain via Electrum provider
  const contractUtxos: any[] = await bchWallet.provider.getUtxos(order.contractAddress).catch(() => []);
  const tokenUtxos: any[] = order.tokenAddress && order.tokenAddress !== order.contractAddress
    ? await bchWallet.provider.getUtxos(order.tokenAddress).catch(() => [])
    : [];

  const seen = new Set<string>();
  const covenantUtxos = [...contractUtxos, ...tokenUtxos].filter(u => {
    const k = `${u.txid}:${u.vout}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!covenantUtxos.length) {
    throw new Error('No unspent covenant UTXO found on-chain. The order may already be filled or refunded.');
  }
  const covenantUtxo = covenantUtxos[0];

  // 2. Fetch fee-paying UTXO from maker's wallet
  const walletUtxos: any[] = await bchWallet.getUtxos().catch(() => []);
  const bchUtxos = walletUtxos.filter((u: any) => !u.token);
  if (!bchUtxos.length) {
    throw new Error('No plain BCH UTXOs in wallet to pay the network fee.');
  }
  const feeUtxo = [...bchUtxos].sort((a: any, b: any) => Number(BigInt(b.satoshis) - BigInt(a.satoshis)))[0];

  // 3. Assemble parameters according to bch-xo-templates specification
  const isSellToken = !!order.sellToken && order.sellToken !== 'BCH' && order.sellToken !== '0x';
  const isBuyToken = !!order.buyToken && order.buyToken !== 'BCH' && order.buyToken !== '0x';
  const sellCat = isSellToken ? order.sellToken.replace(/^0x/, '') : '0x';
  const buyCat = isBuyToken ? order.buyToken.replace(/^0x/, '') : '0x';

  const rawExpiry = (order as any).covenantExpiry
    ?? order.refundableFrom
    ?? (order as any).expiryTime
    ?? Math.floor(Date.now() / 1000);
  const expiryTime = BigInt(rawExpiry);

  const orderParams: LimitOrderParams = {
    makerPkh,
    sellTokenCategory: sellCat,
    buyTokenCategory: buyCat,
    sellAmount: BigInt(order.sellAmount),
    buyAmount: BigInt(order.buyAmount),
    expiryTime,
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const isExpired = order.refundableFrom
    ? nowSec >= order.refundableFrom
    : nowSec >= Number(expiryTime);

  const orderOutpoint: Outpoint = {
    txid: covenantUtxo.txid,
    vout: covenantUtxo.vout,
    satoshis: BigInt(covenantUtxo.satoshis),
    token: covenantUtxo.token ? {
      category: covenantUtxo.token.category,
      amount: BigInt(covenantUtxo.token.amount),
    } : undefined,
  };

  const feeOutpoint: Outpoint = {
    txid: feeUtxo.txid,
    vout: feeUtxo.vout,
    satoshis: BigInt(feeUtxo.satoshis),
  };

  // 4. Build transaction with XO Template logic
  const built = isExpired
    ? buildCancelTransaction({
        orderParams,
        orderUtxo: orderOutpoint,
        feeUtxo: feeOutpoint,
        makerPkh,
        feePkh: makerPkh,
        locktime: nowSec,
        feeSatoshis: 1500n,
      })
    : buildCancelEarlyTransaction({
        orderParams,
        orderUtxo: orderOutpoint,
        feeUtxo: feeOutpoint,
        makerPk,
        makerPkh,
        feePkh: makerPkh,
        feeSatoshis: 1500n,
      });

  const signReq = toWalletSignTxRequest({
    transaction: built.transaction,
    sourceOutputs: built.sourceOutputs,
    redeemScript: built.redeemScript,
    contractName: 'LimitOrderSwap',
    userPrompt: isExpired
      ? `Refund Expired Order: Return funds to Maker`
      : `Cancel Limit Order Early: Return funds to Maker`,
  });

  // 5. Sign via wallet extension internal signer
  const signed = signTransaction(signReq as any, privateKey);

  // 6. Broadcast directly on-chain
  await bchWallet.submitTransaction(signed.bytes);

  // 7. Notify relayer to update order book status
  const relayer = createRelayerApi(networkMode);
  try {
    await fetch(`${relayer.baseUrl}/intent/${order.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txid: signed.txid }),
    });
  } catch (err: any) {
    console.warn('[Orders] Relayer cancel notification note:', err.message || err);
  }

  // 8. Log confirmed activity
  await addActivity({
    kind: 'swap',
    status: 'confirmed',
    network: networkMode === 'mainnet' ? 'bch-mainnet' : 'bch-chipnet',
    account: userAddress,
    sent: '0.000015 BCH',
    received: `${formatAmount(orderParams.sellAmount, 8, 8)} ${isSellToken ? 'Tokens' : 'BCH'}`,
    txid: signed.txid,
    note: isExpired
      ? `Refunded Expired Order (${shortAddr(order.id, 6, 4)})`
      : `Cancelled Limit Order (${shortAddr(order.id, 6, 4)})`,
  }).catch(() => {});

  return { txid: signed.txid, isExpired };
}

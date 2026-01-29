import { Connection, Keypair } from '@solana/web3.js';

export interface DriftDirectOrderParams {
  marketType: 'perp' | 'spot';
  marketIndex: number;
  side: 'buy' | 'sell';
  orderType: 'limit' | 'market';
  baseAmount: string;
  price?: string;
}

export interface DriftDirectOrderResult {
  orderId: string | number;
}

export async function executeDriftDirectOrder(
  connection: Connection,
  keypair: Keypair,
  params: DriftDirectOrderParams
): Promise<DriftDirectOrderResult> {
  const driftSdk = await import('@drift-labs/sdk') as any;
  const anchor = await import('@coral-xyz/anchor');

  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const driftClient = new driftSdk.DriftClient({
    connection,
    wallet: provider.wallet,
    env: 'mainnet-beta',
  });

  await driftClient.subscribe();

  const direction = params.side === 'buy' ? driftSdk.PositionDirection.LONG : driftSdk.PositionDirection.SHORT;
  const orderType = params.orderType === 'market' ? driftSdk.OrderType.MARKET : driftSdk.OrderType.LIMIT;

  const baseAmount = new driftSdk.BN(params.baseAmount);
  const price = params.price ? new driftSdk.BN(params.price) : undefined;

  let orderId: string | number;
  if (params.marketType === 'perp') {
    const txSig = await driftClient.placePerpOrder({
      marketIndex: params.marketIndex,
      direction,
      baseAssetAmount: baseAmount,
      orderType,
      price,
    });
    orderId = txSig;
  } else {
    const txSig = await driftClient.placeSpotOrder({
      marketIndex: params.marketIndex,
      direction,
      baseAssetAmount: baseAmount,
      orderType,
      price,
    });
    orderId = txSig;
  }

  await driftClient.unsubscribe();

  return { orderId };
}

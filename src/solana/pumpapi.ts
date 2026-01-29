import { Connection, Keypair } from '@solana/web3.js';
import { signAndSendVersionedTransaction } from './wallet';

export interface PumpFunTradeParams {
  mint: string;
  action: 'buy' | 'sell';
  amount: number | string;
  denominatedInSol: boolean;
  slippageBps?: number;
  priorityFeeLamports?: number;
  pool?: string;
}

export interface PumpFunTradeResult {
  signature: string;
  endpoint: string;
}

export async function executePumpFunTrade(
  connection: Connection,
  keypair: Keypair,
  params: PumpFunTradeParams
): Promise<PumpFunTradeResult> {
  const endpoint = process.env.PUMPFUN_LOCAL_TX_URL || 'https://pumpportal.fun/api/trade-local';

  const body = {
    publicKey: keypair.publicKey.toBase58(),
    action: params.action,
    mint: params.mint,
    amount: params.amount,
    denominatedInSol: params.denominatedInSol ? 'true' : 'false',
    slippage: params.slippageBps !== undefined ? params.slippageBps / 100 : 1,
    priorityFee: params.priorityFeeLamports !== undefined
      ? params.priorityFeeLamports / 1_000_000_000
      : undefined,
    pool: params.pool || 'pump',
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Pump.fun trade-local error: ${response.status}`);
  }

  const txBytes = new Uint8Array(await response.arrayBuffer());
  const signature = await signAndSendVersionedTransaction(connection, keypair, txBytes);

  return { signature, endpoint };
}

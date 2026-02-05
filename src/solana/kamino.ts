/**
 * Kamino Finance SDK Integration
 *
 * Lending (klend-sdk): deposit, withdraw, borrow, repay
 * Liquidity Vaults (kliquidity-sdk): strategies, vault deposit/withdraw
 */

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { signAndSendTransaction } from './wallet';
import BN from 'bn.js';
import Decimal from 'decimal.js';

// ============================================
// LENDING INTERFACES
// ============================================

export interface KaminoMarketInfo {
  address: string;
  name: string;
  reserves: KaminoReserveInfo[];
}

export interface KaminoReserveInfo {
  address: string;
  symbol: string;
  mint: string;
  decimals: number;
  depositRate: number;
  borrowRate: number;
  totalDeposits: string;
  totalBorrows: string;
  availableLiquidity: string;
  utilizationRate: number;
  ltv: number;
  liquidationThreshold: number;
}

export interface KaminoObligationInfo {
  address: string;
  owner: string;
  deposits: KaminoPositionInfo[];
  borrows: KaminoPositionInfo[];
  totalDepositValue: string;
  totalBorrowValue: string;
  borrowLimit: string;
  liquidationThreshold: string;
  healthFactor: number;
  ltv: number;
}

export interface KaminoPositionInfo {
  reserveAddress: string;
  symbol: string;
  mint: string;
  amount: string;
  amountUsd: string;
}

export interface KaminoDepositParams {
  reserveMint: string;
  amount: string;
  marketAddress?: string;
}

export interface KaminoWithdrawParams {
  reserveMint: string;
  amount: string;
  withdrawAll?: boolean;
  marketAddress?: string;
}

export interface KaminoBorrowParams {
  reserveMint: string;
  amount: string;
  marketAddress?: string;
}

export interface KaminoRepayParams {
  reserveMint: string;
  amount: string;
  repayAll?: boolean;
  marketAddress?: string;
}

export interface KaminoLendingResult {
  signature: string;
  amount?: string;
  symbol?: string;
}

// ============================================
// LIQUIDITY/VAULT INTERFACES
// ============================================

export interface KaminoStrategyInfo {
  address: string;
  name: string;
  tokenAMint: string;
  tokenBMint: string;
  tokenASymbol: string;
  tokenBSymbol: string;
  protocol: string;
  sharePrice: string;
  tvl: string;
  apy: number;
  status: 'active' | 'paused' | 'deprecated';
}

export interface KaminoUserShares {
  strategyAddress: string;
  shares: string;
  tokenAAmount: string;
  tokenBAmount: string;
  valueUsd: string;
}

export interface KaminoVaultDepositParams {
  strategyAddress: string;
  tokenAAmount: string;
  tokenBAmount?: string;
}

export interface KaminoVaultWithdrawParams {
  strategyAddress: string;
  shares?: string;
  withdrawAll?: boolean;
}

export interface KaminoVaultResult {
  signature: string;
  strategyAddress: string;
  shares?: string;
  tokenAAmount?: string;
  tokenBAmount?: string;
}

// ============================================
// MAIN MARKET ADDRESS
// ============================================

const KAMINO_MAIN_MARKET = 'H6rHXmXoCQvq8Ue81MqNh7ow5ysPa1dSozwW3PU1dDH6';
const KLEND_PROGRAM_ID = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';

// ============================================
// LENDING FUNCTIONS
// ============================================

export async function getKaminoMarkets(
  connection: Connection
): Promise<KaminoMarketInfo[]> {
  try {
    const { KaminoMarket } = await import('@kamino-finance/klend-sdk');

    const market = await KaminoMarket.load(
      connection,
      new PublicKey(KAMINO_MAIN_MARKET),
      new PublicKey(KLEND_PROGRAM_ID)
    );

    if (!market) {
      return [];
    }

    const reserves: KaminoReserveInfo[] = [];
    for (const [, reserve] of market.reserves) {
      reserves.push({
        address: reserve.address.toBase58(),
        symbol: reserve.symbol || 'UNKNOWN',
        mint: reserve.getLiquidityMint().toBase58(),
        decimals: reserve.state.liquidity.mintDecimals,
        depositRate: reserve.calculateSupplyAPY() * 100,
        borrowRate: reserve.calculateBorrowAPY() * 100,
        totalDeposits: reserve.getTotalSupply().toString(),
        totalBorrows: reserve.getBorrowedAmount().toString(),
        availableLiquidity: reserve.getLiquidityAvailableAmount().toString(),
        utilizationRate: reserve.calculateUtilizationRatio() * 100,
        ltv: reserve.state.config.loanToValuePct,
        liquidationThreshold: reserve.state.config.liquidationThresholdPct,
      });
    }

    return [{
      address: KAMINO_MAIN_MARKET,
      name: 'Kamino Main Market',
      reserves,
    }];
  } catch (error) {
    console.error('Failed to get Kamino markets:', error);
    return [];
  }
}

export async function getKaminoReserves(
  connection: Connection,
  marketAddress?: string
): Promise<KaminoReserveInfo[]> {
  const markets = await getKaminoMarkets(connection);
  const market = markets.find(m =>
    m.address === (marketAddress || KAMINO_MAIN_MARKET)
  );
  return market?.reserves || [];
}

export async function getKaminoObligation(
  connection: Connection,
  keypair: Keypair,
  marketAddress?: string
): Promise<KaminoObligationInfo | null> {
  try {
    const { KaminoMarket } = await import('@kamino-finance/klend-sdk');

    const market = await KaminoMarket.load(
      connection,
      new PublicKey(marketAddress || KAMINO_MAIN_MARKET),
      new PublicKey(KLEND_PROGRAM_ID)
    );

    if (!market) {
      return null;
    }

    const obligation = await market.getObligationByWallet(keypair.publicKey);
    if (!obligation) {
      return null;
    }

    const deposits: KaminoPositionInfo[] = obligation.deposits.map((d: any) => ({
      reserveAddress: d.reserveAddress.toBase58(),
      symbol: d.symbol || 'UNKNOWN',
      mint: d.mintAddress.toBase58(),
      amount: d.amount.toString(),
      amountUsd: d.marketValueRefreshed?.toString() || '0',
    }));

    const borrows: KaminoPositionInfo[] = obligation.borrows.map((b: any) => ({
      reserveAddress: b.reserveAddress.toBase58(),
      symbol: b.symbol || 'UNKNOWN',
      mint: b.mintAddress.toBase58(),
      amount: b.amount.toString(),
      amountUsd: b.marketValueRefreshed?.toString() || '0',
    }));

    const stats = obligation.refreshedStats;

    return {
      address: obligation.obligationAddress.toBase58(),
      owner: keypair.publicKey.toBase58(),
      deposits,
      borrows,
      totalDepositValue: stats.userTotalDeposit?.toString() || '0',
      totalBorrowValue: stats.userTotalBorrow?.toString() || '0',
      borrowLimit: stats.borrowLimit?.toString() || '0',
      liquidationThreshold: stats.liquidationLtv?.toString() || '0',
      healthFactor: stats.loanToValue ? (1 / stats.loanToValue) : Infinity,
      ltv: (stats.loanToValue || 0) * 100,
    };
  } catch (error) {
    console.error('Failed to get Kamino obligation:', error);
    return null;
  }
}

export async function depositToKamino(
  connection: Connection,
  keypair: Keypair,
  params: KaminoDepositParams
): Promise<KaminoLendingResult> {
  const { KaminoMarket, KaminoAction, VanillaObligation, PROGRAM_ID } =
    await import('@kamino-finance/klend-sdk');

  const market = await KaminoMarket.load(
    connection,
    new PublicKey(params.marketAddress || KAMINO_MAIN_MARKET),
    PROGRAM_ID
  );

  if (!market) {
    throw new Error('Failed to load Kamino market');
  }

  const reserve = market.getReserveByMint(new PublicKey(params.reserveMint));
  if (!reserve) {
    throw new Error(`Reserve not found for mint: ${params.reserveMint}`);
  }

  const amount = new BN(params.amount);

  const action = await KaminoAction.buildDepositTxns(
    market,
    amount,
    reserve.getLiquidityMint(),
    keypair.publicKey,
    new VanillaObligation(PROGRAM_ID)
  );

  const txs = await action.getTransactions();
  let signature = '';

  for (const tx of txs) {
    signature = await signAndSendTransaction(connection, keypair, tx);
  }

  return {
    signature,
    amount: params.amount,
    symbol: reserve.symbol,
  };
}

export async function withdrawFromKamino(
  connection: Connection,
  keypair: Keypair,
  params: KaminoWithdrawParams
): Promise<KaminoLendingResult> {
  const { KaminoMarket, KaminoAction, VanillaObligation, PROGRAM_ID } =
    await import('@kamino-finance/klend-sdk');

  const market = await KaminoMarket.load(
    connection,
    new PublicKey(params.marketAddress || KAMINO_MAIN_MARKET),
    PROGRAM_ID
  );

  if (!market) {
    throw new Error('Failed to load Kamino market');
  }

  const reserve = market.getReserveByMint(new PublicKey(params.reserveMint));
  if (!reserve) {
    throw new Error(`Reserve not found for mint: ${params.reserveMint}`);
  }

  const amount = params.withdrawAll ? 'max' : new BN(params.amount);

  const action = await KaminoAction.buildWithdrawTxns(
    market,
    amount,
    reserve.getLiquidityMint(),
    keypair.publicKey,
    new VanillaObligation(PROGRAM_ID)
  );

  const txs = await action.getTransactions();
  let signature = '';

  for (const tx of txs) {
    signature = await signAndSendTransaction(connection, keypair, tx);
  }

  return {
    signature,
    amount: params.amount,
    symbol: reserve.symbol,
  };
}

export async function borrowFromKamino(
  connection: Connection,
  keypair: Keypair,
  params: KaminoBorrowParams
): Promise<KaminoLendingResult> {
  const { KaminoMarket, KaminoAction, VanillaObligation, PROGRAM_ID } =
    await import('@kamino-finance/klend-sdk');

  const market = await KaminoMarket.load(
    connection,
    new PublicKey(params.marketAddress || KAMINO_MAIN_MARKET),
    PROGRAM_ID
  );

  if (!market) {
    throw new Error('Failed to load Kamino market');
  }

  const reserve = market.getReserveByMint(new PublicKey(params.reserveMint));
  if (!reserve) {
    throw new Error(`Reserve not found for mint: ${params.reserveMint}`);
  }

  const amount = new BN(params.amount);

  const action = await KaminoAction.buildBorrowTxns(
    market,
    amount,
    reserve.getLiquidityMint(),
    keypair.publicKey,
    new VanillaObligation(PROGRAM_ID)
  );

  const txs = await action.getTransactions();
  let signature = '';

  for (const tx of txs) {
    signature = await signAndSendTransaction(connection, keypair, tx);
  }

  return {
    signature,
    amount: params.amount,
    symbol: reserve.symbol,
  };
}

export async function repayToKamino(
  connection: Connection,
  keypair: Keypair,
  params: KaminoRepayParams
): Promise<KaminoLendingResult> {
  const { KaminoMarket, KaminoAction, VanillaObligation, PROGRAM_ID } =
    await import('@kamino-finance/klend-sdk');

  const market = await KaminoMarket.load(
    connection,
    new PublicKey(params.marketAddress || KAMINO_MAIN_MARKET),
    PROGRAM_ID
  );

  if (!market) {
    throw new Error('Failed to load Kamino market');
  }

  const reserve = market.getReserveByMint(new PublicKey(params.reserveMint));
  if (!reserve) {
    throw new Error(`Reserve not found for mint: ${params.reserveMint}`);
  }

  const amount = params.repayAll ? 'max' : new BN(params.amount);

  const action = await KaminoAction.buildRepayTxns(
    market,
    amount,
    reserve.getLiquidityMint(),
    keypair.publicKey,
    new VanillaObligation(PROGRAM_ID)
  );

  const txs = await action.getTransactions();
  let signature = '';

  for (const tx of txs) {
    signature = await signAndSendTransaction(connection, keypair, tx);
  }

  return {
    signature,
    amount: params.amount,
    symbol: reserve.symbol,
  };
}

// ============================================
// LIQUIDITY/VAULT FUNCTIONS
// ============================================

export async function getKaminoStrategies(
  connection: Connection
): Promise<KaminoStrategyInfo[]> {
  try {
    const { Kamino } = await import('@kamino-finance/kliquidity-sdk');
    const kamino = new Kamino('mainnet-beta', connection);

    const strategies = await kamino.getStrategies();
    const results: KaminoStrategyInfo[] = [];

    for (const strategy of strategies) {
      try {
        const sharePrice = await kamino.getStrategySharePrice(strategy.address);

        results.push({
          address: strategy.address.toBase58(),
          name: strategy.strategyLookupTable?.toBase58() || 'Unknown',
          tokenAMint: strategy.tokenAMint.toBase58(),
          tokenBMint: strategy.tokenBMint.toBase58(),
          tokenASymbol: 'TokenA',
          tokenBSymbol: 'TokenB',
          protocol: strategy.strategyDex?.toString() || 'Unknown',
          sharePrice: sharePrice?.toString() || '0',
          tvl: '0',
          apy: 0,
          status: 'active',
        });
      } catch {
        // Skip strategies that fail to load
      }
    }

    return results;
  } catch (error) {
    console.error('Failed to get Kamino strategies:', error);
    return [];
  }
}

export async function getKaminoStrategy(
  connection: Connection,
  strategyAddress: string
): Promise<KaminoStrategyInfo | null> {
  try {
    const { Kamino } = await import('@kamino-finance/kliquidity-sdk');
    const kamino = new Kamino('mainnet-beta', connection);

    const strategy = await kamino.getStrategyByAddress(new PublicKey(strategyAddress));
    if (!strategy) {
      return null;
    }

    const sharePrice = await kamino.getStrategySharePrice(new PublicKey(strategyAddress));

    return {
      address: strategyAddress,
      name: strategy.strategyLookupTable?.toBase58() || 'Unknown',
      tokenAMint: strategy.tokenAMint.toBase58(),
      tokenBMint: strategy.tokenBMint.toBase58(),
      tokenASymbol: 'TokenA',
      tokenBSymbol: 'TokenB',
      protocol: strategy.strategyDex?.toString() || 'Unknown',
      sharePrice: sharePrice?.toString() || '0',
      tvl: '0',
      apy: 0,
      status: 'active',
    };
  } catch (error) {
    console.error('Failed to get Kamino strategy:', error);
    return null;
  }
}

export async function getKaminoUserShares(
  connection: Connection,
  keypair: Keypair,
  strategyAddress?: string
): Promise<KaminoUserShares[]> {
  try {
    const { Kamino } = await import('@kamino-finance/kliquidity-sdk');
    const kamino = new Kamino('mainnet-beta', connection);

    if (strategyAddress) {
      const strategy = await kamino.getStrategyByAddress(new PublicKey(strategyAddress));
      if (!strategy) {
        return [];
      }

      const holders = await kamino.getStrategyHolders(strategy);
      const userHolding = holders.find((h: any) =>
        h.holderPubkey.equals(keypair.publicKey)
      );

      if (!userHolding) {
        return [];
      }

      return [{
        strategyAddress,
        shares: userHolding.shares.toString(),
        tokenAAmount: '0',
        tokenBAmount: '0',
        valueUsd: '0',
      }];
    }

    // Get shares across all strategies
    const strategies = await kamino.getStrategies();
    const results: KaminoUserShares[] = [];

    for (const strategy of strategies) {
      try {
        const holders = await kamino.getStrategyHolders(strategy);
        const userHolding = holders.find((h: any) =>
          h.holderPubkey.equals(keypair.publicKey)
        );

        if (userHolding && userHolding.shares.gt(new Decimal(0))) {
          results.push({
            strategyAddress: strategy.address.toBase58(),
            shares: userHolding.shares.toString(),
            tokenAAmount: '0',
            tokenBAmount: '0',
            valueUsd: '0',
          });
        }
      } catch {
        // Skip strategies that fail
      }
    }

    return results;
  } catch (error) {
    console.error('Failed to get Kamino user shares:', error);
    return [];
  }
}

export async function depositToKaminoVault(
  connection: Connection,
  keypair: Keypair,
  params: KaminoVaultDepositParams
): Promise<KaminoVaultResult> {
  const { Kamino } = await import('@kamino-finance/kliquidity-sdk');
  const kamino = new Kamino('mainnet-beta', connection);

  const strategy = await kamino.getStrategyByAddress(new PublicKey(params.strategyAddress));
  if (!strategy) {
    throw new Error(`Strategy not found: ${params.strategyAddress}`);
  }

  const tokenAAmount = new Decimal(params.tokenAAmount);
  const tokenBAmount = params.tokenBAmount ? new Decimal(params.tokenBAmount) : new Decimal(0);

  const depositIx = await kamino.deposit(
    { strategy, address: new PublicKey(params.strategyAddress) },
    tokenAAmount,
    tokenBAmount,
    keypair.publicKey
  );

  const tx = new Transaction().add(depositIx);
  const signature = await signAndSendTransaction(connection, keypair, tx);

  return {
    signature,
    strategyAddress: params.strategyAddress,
    tokenAAmount: params.tokenAAmount,
    tokenBAmount: params.tokenBAmount,
  };
}

export async function withdrawFromKaminoVault(
  connection: Connection,
  keypair: Keypair,
  params: KaminoVaultWithdrawParams
): Promise<KaminoVaultResult> {
  const { Kamino } = await import('@kamino-finance/kliquidity-sdk');
  const kamino = new Kamino('mainnet-beta', connection);

  const strategy = await kamino.getStrategyByAddress(new PublicKey(params.strategyAddress));
  if (!strategy) {
    throw new Error(`Strategy not found: ${params.strategyAddress}`);
  }

  let withdrawIx;

  if (params.withdrawAll) {
    withdrawIx = await kamino.withdrawAllShares(
      { strategy, address: new PublicKey(params.strategyAddress) },
      keypair.publicKey
    );
  } else if (params.shares) {
    withdrawIx = await kamino.withdrawShares(
      { strategy, address: new PublicKey(params.strategyAddress) },
      new Decimal(params.shares),
      keypair.publicKey
    );
  } else {
    throw new Error('Must specify shares or withdrawAll');
  }

  if (!withdrawIx) {
    throw new Error('No shares to withdraw');
  }

  const tx = new Transaction().add(withdrawIx);
  const signature = await signAndSendTransaction(connection, keypair, tx);

  return {
    signature,
    strategyAddress: params.strategyAddress,
    shares: params.shares,
  };
}

export async function getKaminoSharePrice(
  connection: Connection,
  strategyAddress: string
): Promise<string> {
  try {
    const { Kamino } = await import('@kamino-finance/kliquidity-sdk');
    const kamino = new Kamino('mainnet-beta', connection);

    const price = await kamino.getStrategySharePrice(new PublicKey(strategyAddress));
    return price?.toString() || '0';
  } catch (error) {
    console.error('Failed to get share price:', error);
    return '0';
  }
}

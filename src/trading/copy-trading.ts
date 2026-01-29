/**
 * Copy Trading System
 *
 * Automatically mirrors trades from followed whale addresses.
 * Supports:
 * - Following multiple addresses
 * - Position sizing (fixed, proportional, or percentage)
 * - Delay before copying (to avoid front-running detection)
 * - Filters (min trade size, max position, markets)
 * - Stop loss / take profit
 */

import { EventEmitter } from 'eventemitter3';
import { logger } from '../utils/logger';
import type { Platform } from '../types';
import type { ExecutionService, OrderResult } from '../execution/index';
import type { WhaleTracker, WhaleTrade, WhalePosition } from '../feeds/polymarket/whale-tracker';

// =============================================================================
// TYPES
// =============================================================================

export type SizingMode = 'fixed' | 'proportional' | 'percentage';

export interface CopyTradingConfig {
  /** Addresses to copy */
  followedAddresses: string[];
  /** Sizing mode (default: 'fixed') */
  sizingMode?: SizingMode;
  /** Fixed size in $ (for 'fixed' mode, default: 100) */
  fixedSize?: number;
  /** Proportion of whale's trade (for 'proportional' mode, default: 0.1 = 10%) */
  proportionMultiplier?: number;
  /** Percentage of portfolio (for 'percentage' mode, default: 5) */
  portfolioPercentage?: number;
  /** Maximum position size per market $ (default: 500) */
  maxPositionSize?: number;
  /** Minimum trade size to copy $ (default: 1000) */
  minTradeSize?: number;
  /** Delay before copying in ms (default: 5000) */
  copyDelayMs?: number;
  /** Maximum slippage % (default: 2) */
  maxSlippage?: number;
  /** Stop loss % (default: none) */
  stopLoss?: number;
  /** Take profit % (default: none) */
  takeProfit?: number;
  /** Markets to exclude */
  excludedMarkets?: string[];
  /** Only copy these platforms */
  enabledPlatforms?: Platform[];
  /** Dry run mode (default: true) */
  dryRun?: boolean;
}

export interface CopiedTrade {
  id: string;
  originalTrade: WhaleTrade;
  copiedAt: Date;
  side: 'BUY' | 'SELL';
  size: number;
  entryPrice: number;
  exitPrice?: number;
  status: 'pending' | 'filled' | 'partial' | 'failed' | 'closed';
  pnl?: number;
  orderResult?: OrderResult;
}

export interface CopyTradingStats {
  totalCopied: number;
  totalSkipped: number;
  totalPnl: number;
  winRate: number;
  avgReturn: number;
  openPositions: number;
  followedAddresses: number;
}

export interface CopyTradingEvents {
  tradeCopied: (trade: CopiedTrade) => void;
  tradeSkipped: (trade: WhaleTrade, reason: string) => void;
  positionClosed: (trade: CopiedTrade, pnl: number) => void;
  error: (error: Error) => void;
}

export interface CopyTradingService extends EventEmitter<keyof CopyTradingEvents> {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  follow(address: string): void;
  unfollow(address: string): void;
  getFollowedAddresses(): string[];
  getCopiedTrades(limit?: number): CopiedTrade[];
  getOpenPositions(): CopiedTrade[];
  getStats(): CopyTradingStats;
  closePosition(tradeId: string): Promise<void>;
  closeAllPositions(): Promise<void>;
  updateConfig(config: Partial<CopyTradingConfig>): void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_CONFIG: Required<CopyTradingConfig> = {
  followedAddresses: [],
  sizingMode: 'fixed',
  fixedSize: 100,
  proportionMultiplier: 0.1,
  portfolioPercentage: 5,
  maxPositionSize: 500,
  minTradeSize: 1000,
  copyDelayMs: 5000,
  maxSlippage: 2,
  stopLoss: 0,
  takeProfit: 0,
  excludedMarkets: [],
  enabledPlatforms: ['polymarket', 'kalshi'],
  dryRun: true,
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function createCopyTradingService(
  whaleTracker: WhaleTracker,
  execution: ExecutionService,
  config: CopyTradingConfig
): CopyTradingService {
  const emitter = new EventEmitter() as CopyTradingService;
  let cfg = { ...DEFAULT_CONFIG, ...config };

  let running = false;
  const followedAddresses = new Set<string>(cfg.followedAddresses);
  const copiedTrades: CopiedTrade[] = [];
  const openPositions = new Map<string, CopiedTrade>();
  const pendingCopies = new Map<string, NodeJS.Timeout>();

  // Stats
  const stats: CopyTradingStats = {
    totalCopied: 0,
    totalSkipped: 0,
    totalPnl: 0,
    winRate: 0,
    avgReturn: 0,
    openPositions: 0,
    followedAddresses: followedAddresses.size,
  };

  // ==========================================================================
  // SIZING CALCULATION
  // ==========================================================================

  function calculateSize(trade: WhaleTrade, portfolioValue = 10000): number {
    let size: number;

    switch (cfg.sizingMode) {
      case 'fixed':
        size = cfg.fixedSize;
        break;

      case 'proportional':
        size = trade.usdValue * cfg.proportionMultiplier;
        break;

      case 'percentage':
        size = portfolioValue * (cfg.portfolioPercentage / 100);
        break;

      default:
        size = cfg.fixedSize;
    }

    // Cap at max position size
    return Math.min(size, cfg.maxPositionSize);
  }

  // ==========================================================================
  // TRADE FILTERING
  // ==========================================================================

  function shouldCopy(trade: WhaleTrade): { copy: boolean; reason?: string } {
    // Check if address is followed
    if (!followedAddresses.has(trade.maker) && !followedAddresses.has(trade.taker)) {
      return { copy: false, reason: 'address_not_followed' };
    }

    // Check minimum size
    if (trade.usdValue < cfg.minTradeSize) {
      return { copy: false, reason: `trade_too_small ($${trade.usdValue} < $${cfg.minTradeSize})` };
    }

    // Check excluded markets
    if (cfg.excludedMarkets.includes(trade.marketId)) {
      return { copy: false, reason: 'market_excluded' };
    }

    // Check if we already have max position in this market
    const existingPosition = Array.from(openPositions.values()).find(
      (p) => p.originalTrade.marketId === trade.marketId
    );
    if (existingPosition && existingPosition.size * existingPosition.entryPrice >= cfg.maxPositionSize) {
      return { copy: false, reason: 'max_position_reached' };
    }

    return { copy: true };
  }

  // ==========================================================================
  // TRADE EXECUTION
  // ==========================================================================

  async function copyTrade(trade: WhaleTrade): Promise<void> {
    const tradeId = `copy_${trade.id}_${Date.now()}`;
    const size = calculateSize(trade);
    const shares = size / trade.price;

    const copiedTrade: CopiedTrade = {
      id: tradeId,
      originalTrade: trade,
      copiedAt: new Date(),
      side: trade.side,
      size: shares,
      entryPrice: trade.price,
      status: 'pending',
    };

    logger.info(
      {
        tradeId,
        marketId: trade.marketId,
        side: trade.side,
        size: shares,
        price: trade.price,
        dryRun: cfg.dryRun,
      },
      'Copying trade'
    );

    if (cfg.dryRun) {
      // Simulate successful execution
      copiedTrade.status = 'filled';
      copiedTrade.orderResult = {
        success: true,
        orderId: `dry_${tradeId}`,
        status: 'filled',
        filledSize: shares,
        avgFillPrice: trade.price,
      };
    } else {
      try {
        // Execute the trade
        let result: OrderResult;

        if (trade.side === 'BUY') {
          result = await execution.buyLimit({
            platform: 'polymarket',
            marketId: trade.marketId,
            tokenId: trade.tokenId,
            outcome: trade.outcome,
            price: trade.price * (1 + cfg.maxSlippage / 100), // Allow slippage
            size: shares,
            orderType: 'GTC',
          });
        } else {
          result = await execution.sellLimit({
            platform: 'polymarket',
            marketId: trade.marketId,
            tokenId: trade.tokenId,
            outcome: trade.outcome,
            price: trade.price * (1 - cfg.maxSlippage / 100),
            size: shares,
            orderType: 'GTC',
          });
        }

        copiedTrade.orderResult = result;
        copiedTrade.status = result.success ? 'filled' : 'failed';
        copiedTrade.entryPrice = result.avgFillPrice || trade.price;
      } catch (error) {
        copiedTrade.status = 'failed';
        logger.error({ tradeId, error }, 'Failed to copy trade');
        emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }

    copiedTrades.unshift(copiedTrade);
    if (copiedTrades.length > 1000) {
      copiedTrades.pop();
    }

    if (copiedTrade.status === 'filled') {
      openPositions.set(tradeId, copiedTrade);
      stats.totalCopied++;
      stats.openPositions = openPositions.size;

      logger.info({ tradeId, status: copiedTrade.status }, 'Trade copied successfully');
      emitter.emit('tradeCopied', copiedTrade);

      // Set up stop loss / take profit monitoring if configured
      if (cfg.stopLoss > 0 || cfg.takeProfit > 0) {
        monitorPosition(copiedTrade);
      }
    }
  }

  function monitorPosition(trade: CopiedTrade): void {
    // In a real implementation, this would subscribe to price updates
    // and close the position when SL/TP is hit
    // For now, this is a placeholder
    logger.debug({ tradeId: trade.id, stopLoss: cfg.stopLoss, takeProfit: cfg.takeProfit }, 'Monitoring position');
  }

  // ==========================================================================
  // EVENT HANDLERS
  // ==========================================================================

  function handleWhaleTrade(trade: WhaleTrade): void {
    const { copy, reason } = shouldCopy(trade);

    if (!copy) {
      stats.totalSkipped++;
      logger.debug({ tradeId: trade.id, reason }, 'Skipping trade');
      emitter.emit('tradeSkipped', trade, reason!);
      return;
    }

    // Schedule copy with delay
    const timeoutId = setTimeout(() => {
      pendingCopies.delete(trade.id);
      copyTrade(trade).catch((error) => {
        logger.error({ tradeId: trade.id, error }, 'Error copying trade');
      });
    }, cfg.copyDelayMs);

    pendingCopies.set(trade.id, timeoutId);
    logger.info({ tradeId: trade.id, delayMs: cfg.copyDelayMs }, 'Scheduled trade copy');
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  Object.assign(emitter, {
    start(): void {
      if (running) return;

      running = true;
      logger.info({ config: cfg, followedCount: followedAddresses.size }, 'Starting copy trading');

      // Listen to whale trades
      whaleTracker.on('trade', handleWhaleTrade);
    },

    stop(): void {
      if (!running) return;

      running = false;

      // Stop listening
      whaleTracker.off('trade', handleWhaleTrade);

      // Cancel pending copies
      for (const timeoutId of pendingCopies.values()) {
        clearTimeout(timeoutId);
      }
      pendingCopies.clear();

      logger.info('Copy trading stopped');
    },

    isRunning(): boolean {
      return running;
    },

    follow(address: string): void {
      followedAddresses.add(address);
      whaleTracker.trackAddress(address);
      stats.followedAddresses = followedAddresses.size;
      logger.info({ address }, 'Now following address');
    },

    unfollow(address: string): void {
      followedAddresses.delete(address);
      stats.followedAddresses = followedAddresses.size;
      logger.info({ address }, 'Stopped following address');
    },

    getFollowedAddresses(): string[] {
      return Array.from(followedAddresses);
    },

    getCopiedTrades(limit = 100): CopiedTrade[] {
      return copiedTrades.slice(0, limit);
    },

    getOpenPositions(): CopiedTrade[] {
      return Array.from(openPositions.values());
    },

    getStats(): CopyTradingStats {
      return { ...stats };
    },

    async closePosition(tradeId: string): Promise<void> {
      const position = openPositions.get(tradeId);
      if (!position) {
        throw new Error(`Position ${tradeId} not found`);
      }

      // In real implementation, would sell the position
      const pnl = 0; // Would calculate actual PnL

      position.status = 'closed';
      position.pnl = pnl;
      openPositions.delete(tradeId);

      stats.openPositions = openPositions.size;
      stats.totalPnl += pnl;

      emitter.emit('positionClosed', position, pnl);
      logger.info({ tradeId, pnl }, 'Position closed');
    },

    async closeAllPositions(): Promise<void> {
      const positions = Array.from(openPositions.keys());
      for (const tradeId of positions) {
        await emitter.closePosition(tradeId);
      }
    },

    updateConfig(newConfig: Partial<CopyTradingConfig>): void {
      cfg = { ...cfg, ...newConfig };

      if (newConfig.followedAddresses) {
        followedAddresses.clear();
        for (const addr of newConfig.followedAddresses) {
          followedAddresses.add(addr);
        }
        stats.followedAddresses = followedAddresses.size;
      }

      logger.info({ config: cfg }, 'Copy trading config updated');
    },
  } as Partial<CopyTradingService>);

  return emitter;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Find the best addresses to copy based on historical performance
 */
export async function findBestAddressesToCopy(
  whaleTracker: WhaleTracker,
  options: {
    minWinRate?: number;
    minTrades?: number;
    minAvgReturn?: number;
    limit?: number;
  } = {}
): Promise<Array<{ address: string; winRate: number; avgReturn: number; totalTrades: number }>> {
  const { minWinRate = 55, minTrades = 10, minAvgReturn = 5, limit = 10 } = options;

  const whales = whaleTracker.getKnownWhales();

  return whales
    .filter((w) => w.winRate >= minWinRate && w.avgReturn >= minAvgReturn)
    .filter((w) => w.recentTrades.length >= minTrades)
    .map((w) => ({
      address: w.address,
      winRate: w.winRate,
      avgReturn: w.avgReturn,
      totalTrades: w.recentTrades.length,
    }))
    .sort((a, b) => b.avgReturn - a.avgReturn)
    .slice(0, limit);
}

// =============================================================================
// EXPORTS
// =============================================================================

export type { CopyTradingConfig as CopyConfig };

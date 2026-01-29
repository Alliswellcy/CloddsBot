/**
 * Trading Bot Framework
 *
 * Create and manage automated trading strategies
 *
 * Features:
 * - Strategy definition (entry/exit rules)
 * - Live execution with auto-logging
 * - Backtesting on historical data
 * - Performance tracking
 * - Risk management integration
 */

import { EventEmitter } from 'eventemitter3';
import { Database } from '../../db/index';
import { logger } from '../../utils/logger';
import { createTradeLogger, TradeLogger, Trade } from '../logger';
import type { Platform, Market } from '../../types';

// =============================================================================
// TYPES
// =============================================================================

export type SignalType = 'buy' | 'sell' | 'hold' | 'close';

export interface Signal {
  type: SignalType;
  platform: Platform;
  marketId: string;
  outcome: string;
  /** Target price (for limit orders) */
  price?: number;
  /** Position size (USD or shares) */
  size?: number;
  /** Size as percentage of portfolio */
  sizePct?: number;
  /** Confidence (0-1) */
  confidence?: number;
  /** Reason for signal */
  reason?: string;
  /** Additional metadata */
  meta?: Record<string, unknown>;
}

export interface StrategyContext {
  /** Current portfolio value */
  portfolioValue: number;
  /** Available balance */
  availableBalance: number;
  /** Current positions */
  positions: Map<string, { shares: number; avgPrice: number; currentPrice: number }>;
  /** Recent trades for this strategy */
  recentTrades: Trade[];
  /** Market data */
  markets: Map<string, Market>;
  /** Price history (marketId -> prices) */
  priceHistory: Map<string, number[]>;
  /** Current timestamp */
  timestamp: Date;
  /** Is this a backtest? */
  isBacktest: boolean;
}

export interface StrategyConfig {
  id: string;
  name: string;
  description?: string;
  /** Platforms to trade on */
  platforms: Platform[];
  /** Markets to watch (empty = all) */
  markets?: string[];
  /** Check interval in ms */
  intervalMs?: number;
  /** Max position size (USD) */
  maxPositionSize?: number;
  /** Max total exposure (USD) */
  maxExposure?: number;
  /** Stop loss percentage */
  stopLossPct?: number;
  /** Take profit percentage */
  takeProfitPct?: number;
  /** Enable/disable */
  enabled?: boolean;
  /** Dry run mode */
  dryRun?: boolean;
  /** Custom parameters */
  params?: Record<string, unknown>;
}

export interface Strategy {
  config: StrategyConfig;

  /** Initialize strategy (called once) */
  init?(ctx: StrategyContext): Promise<void>;

  /** Generate signals based on current context */
  evaluate(ctx: StrategyContext): Promise<Signal[]>;

  /** Called when a trade is executed */
  onTrade?(trade: Trade): void;

  /** Called when position changes */
  onPositionChange?(position: { marketId: string; shares: number; pnl: number }): void;

  /** Cleanup (called on stop) */
  cleanup?(): Promise<void>;
}

export interface BotStatus {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'paused' | 'error';
  startedAt?: Date;
  lastCheck?: Date;
  lastSignal?: Signal;
  lastError?: string;
  tradesCount: number;
  totalPnL: number;
  winRate: number;
}

export interface BotManager extends EventEmitter {
  /** Register a strategy */
  registerStrategy(strategy: Strategy): void;

  /** Unregister a strategy */
  unregisterStrategy(strategyId: string): void;

  /** Start a bot */
  startBot(strategyId: string): Promise<boolean>;

  /** Stop a bot */
  stopBot(strategyId: string): Promise<void>;

  /** Pause a bot (stops trading but keeps monitoring) */
  pauseBot(strategyId: string): void;

  /** Resume a paused bot */
  resumeBot(strategyId: string): void;

  /** Get bot status */
  getBotStatus(strategyId: string): BotStatus | null;

  /** Get all bot statuses */
  getAllBotStatuses(): BotStatus[];

  /** Get registered strategies */
  getStrategies(): StrategyConfig[];

  /** Update strategy config */
  updateStrategyConfig(strategyId: string, updates: Partial<StrategyConfig>): boolean;

  /** Manually trigger evaluation */
  evaluateNow(strategyId: string): Promise<Signal[]>;

  /** Get trade logger */
  getTradeLogger(): TradeLogger;

  /** Backtest a strategy */
  backtest(
    strategyId: string,
    startDate: Date,
    endDate: Date,
    initialCapital: number
  ): Promise<BacktestResult>;
}

export interface BacktestResult {
  strategyId: string;
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  finalCapital: number;
  totalReturn: number;
  totalReturnPct: number;
  trades: Trade[];
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRate: number;
  profitFactor: number;
  avgTrade: number;
  dailyReturns: Array<{ date: string; return: number; cumulative: number }>;
}

// =============================================================================
// BOT MANAGER IMPLEMENTATION
// =============================================================================

export interface BotManagerConfig {
  /** Default check interval */
  defaultIntervalMs?: number;
  /** Execute handler for live trading */
  executeOrder?: (signal: Signal, strategyId: string) => Promise<Trade | null>;
  /** Price provider */
  getPrice?: (platform: Platform, marketId: string) => Promise<number | null>;
  /** Market data provider */
  getMarket?: (platform: Platform, marketId: string) => Promise<Market | null>;
  /** Portfolio provider */
  getPortfolio?: () => Promise<{ value: number; balance: number; positions: any[] }>;
}

export function createBotManager(db: Database, config: BotManagerConfig = {}): BotManager {
  const emitter = new EventEmitter() as BotManager;
  const tradeLogger = createTradeLogger(db);
  const strategies = new Map<string, Strategy>();
  const botIntervals = new Map<string, NodeJS.Timeout>();
  const botStatuses = new Map<string, BotStatus>();

  const defaultIntervalMs = config.defaultIntervalMs || 60000; // 1 minute

  // Initialize database for bot state
  db.run(`
    CREATE TABLE IF NOT EXISTS bot_state (
      strategy_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at TEXT,
      last_check TEXT,
      last_signal_json TEXT,
      last_error TEXT,
      config_json TEXT
    )
  `);

  // Build context for strategy evaluation
  async function buildContext(strategy: Strategy, isBacktest = false): Promise<StrategyContext> {
    const portfolio = config.getPortfolio
      ? await config.getPortfolio()
      : { value: 10000, balance: 10000, positions: [] };

    const positions = new Map<string, { shares: number; avgPrice: number; currentPrice: number }>();
    for (const pos of portfolio.positions) {
      positions.set(`${pos.platform}:${pos.marketId}:${pos.outcome}`, {
        shares: pos.shares,
        avgPrice: pos.avgPrice,
        currentPrice: pos.currentPrice,
      });
    }

    const recentTrades = tradeLogger.getTrades({
      strategyId: strategy.config.id,
      limit: 100,
    });

    return {
      portfolioValue: portfolio.value,
      availableBalance: portfolio.balance,
      positions,
      recentTrades,
      markets: new Map(),
      priceHistory: new Map(),
      timestamp: new Date(),
      isBacktest,
    };
  }

  // Execute signals
  async function executeSignals(strategy: Strategy, signals: Signal[]): Promise<void> {
    for (const signal of signals) {
      if (signal.type === 'hold') continue;

      // Check risk limits
      const cfg = strategy.config;
      if (cfg.maxPositionSize && signal.size && signal.size > cfg.maxPositionSize) {
        logger.warn({ strategyId: cfg.id, size: signal.size, max: cfg.maxPositionSize }, 'Signal exceeds max position size');
        signal.size = cfg.maxPositionSize;
      }

      // Execute order
      if (cfg.dryRun) {
        logger.info({ strategyId: cfg.id, signal }, 'Signal (dry run)');

        // Log as dry-run trade
        tradeLogger.logTrade({
          platform: signal.platform,
          marketId: signal.marketId,
          outcome: signal.outcome,
          side: signal.type === 'buy' ? 'buy' : 'sell',
          orderType: signal.price ? 'limit' : 'market',
          price: signal.price || 0.5,
          size: signal.size || 100,
          filled: signal.size || 100,
          cost: (signal.price || 0.5) * (signal.size || 100),
          status: 'filled',
          strategyId: cfg.id,
          strategyName: cfg.name,
          meta: { dryRun: true, confidence: signal.confidence, reason: signal.reason },
        });
      } else if (config.executeOrder) {
        try {
          const trade = await config.executeOrder(signal, cfg.id);

          if (trade) {
            strategy.onTrade?.(trade);
            emitter.emit('trade', { strategyId: cfg.id, trade });
          }
        } catch (err) {
          logger.error({ err, strategyId: cfg.id, signal }, 'Failed to execute signal');
          updateBotStatus(cfg.id, { lastError: String(err) });
        }
      }
    }
  }

  // Update bot status
  function updateBotStatus(strategyId: string, updates: Partial<BotStatus>): void {
    const current = botStatuses.get(strategyId);
    if (!current) return;

    Object.assign(current, updates);

    // Persist to DB
    db.run(
      `UPDATE bot_state SET status = ?, last_check = ?, last_signal_json = ?, last_error = ?
       WHERE strategy_id = ?`,
      [
        current.status,
        current.lastCheck?.toISOString() || null,
        current.lastSignal ? JSON.stringify(current.lastSignal) : null,
        current.lastError || null,
        strategyId,
      ]
    );
  }

  // Run one evaluation cycle
  async function runEvaluation(strategy: Strategy): Promise<Signal[]> {
    const status = botStatuses.get(strategy.config.id);
    if (!status || status.status !== 'running') return [];

    try {
      const ctx = await buildContext(strategy);
      const signals = await strategy.evaluate(ctx);

      updateBotStatus(strategy.config.id, {
        lastCheck: new Date(),
        lastSignal: signals[0],
        lastError: undefined,
      });

      if (signals.length > 0) {
        emitter.emit('signals', { strategyId: strategy.config.id, signals });
        await executeSignals(strategy, signals);
      }

      return signals;
    } catch (err) {
      logger.error({ err, strategyId: strategy.config.id }, 'Strategy evaluation failed');
      updateBotStatus(strategy.config.id, {
        status: 'error',
        lastError: String(err),
      });
      return [];
    }
  }

  // Attach methods
  Object.assign(emitter, {
    registerStrategy(strategy) {
      strategies.set(strategy.config.id, strategy);

      // Initialize status
      const stats = tradeLogger.getStats({ strategyId: strategy.config.id });
      botStatuses.set(strategy.config.id, {
        id: strategy.config.id,
        name: strategy.config.name,
        status: 'stopped',
        tradesCount: stats.totalTrades,
        totalPnL: stats.totalPnL,
        winRate: stats.winRate,
      });

      // Persist config
      db.run(
        `INSERT OR REPLACE INTO bot_state (strategy_id, status, config_json) VALUES (?, ?, ?)`,
        [strategy.config.id, 'stopped', JSON.stringify(strategy.config)]
      );

      logger.info({ strategyId: strategy.config.id, name: strategy.config.name }, 'Strategy registered');
      emitter.emit('strategyRegistered', strategy.config);
    },

    unregisterStrategy(strategyId) {
      const strategy = strategies.get(strategyId);
      if (!strategy) return;

      // Stop if running
      emitter.stopBot(strategyId);

      strategies.delete(strategyId);
      botStatuses.delete(strategyId);

      logger.info({ strategyId }, 'Strategy unregistered');
    },

    async startBot(strategyId) {
      const strategy = strategies.get(strategyId);
      if (!strategy) {
        logger.error({ strategyId }, 'Strategy not found');
        return false;
      }

      const status = botStatuses.get(strategyId);
      if (status?.status === 'running') {
        logger.warn({ strategyId }, 'Bot already running');
        return false;
      }

      // Initialize strategy
      if (strategy.init) {
        const ctx = await buildContext(strategy);
        await strategy.init(ctx);
      }

      // Update status
      updateBotStatus(strategyId, {
        status: 'running',
        startedAt: new Date(),
        lastError: undefined,
      });

      // Start evaluation loop
      const intervalMs = strategy.config.intervalMs || defaultIntervalMs;
      const interval = setInterval(() => {
        runEvaluation(strategy);
      }, intervalMs);
      botIntervals.set(strategyId, interval);

      // Run initial evaluation
      runEvaluation(strategy);

      logger.info({ strategyId, intervalMs }, 'Bot started');
      emitter.emit('botStarted', strategyId);

      return true;
    },

    async stopBot(strategyId) {
      const interval = botIntervals.get(strategyId);
      if (interval) {
        clearInterval(interval);
        botIntervals.delete(strategyId);
      }

      const strategy = strategies.get(strategyId);
      if (strategy?.cleanup) {
        await strategy.cleanup();
      }

      updateBotStatus(strategyId, { status: 'stopped' });

      logger.info({ strategyId }, 'Bot stopped');
      emitter.emit('botStopped', strategyId);
    },

    pauseBot(strategyId) {
      updateBotStatus(strategyId, { status: 'paused' });
      logger.info({ strategyId }, 'Bot paused');
    },

    resumeBot(strategyId) {
      const status = botStatuses.get(strategyId);
      if (status?.status === 'paused') {
        updateBotStatus(strategyId, { status: 'running' });
        logger.info({ strategyId }, 'Bot resumed');
      }
    },

    getBotStatus(strategyId) {
      return botStatuses.get(strategyId) || null;
    },

    getAllBotStatuses() {
      return Array.from(botStatuses.values());
    },

    getStrategies() {
      return Array.from(strategies.values()).map((s) => s.config);
    },

    updateStrategyConfig(strategyId, updates) {
      const strategy = strategies.get(strategyId);
      if (!strategy) return false;

      Object.assign(strategy.config, updates);

      db.run(
        `UPDATE bot_state SET config_json = ? WHERE strategy_id = ?`,
        [JSON.stringify(strategy.config), strategyId]
      );

      return true;
    },

    async evaluateNow(strategyId) {
      const strategy = strategies.get(strategyId);
      if (!strategy) return [];

      const ctx = await buildContext(strategy);
      return strategy.evaluate(ctx);
    },

    getTradeLogger() {
      return tradeLogger;
    },

    async backtest(strategyId, startDate, endDate, initialCapital) {
      const strategy = strategies.get(strategyId);
      if (!strategy) {
        throw new Error(`Strategy ${strategyId} not found`);
      }

      // Simplified backtest (would need historical data in production)
      const result: BacktestResult = {
        strategyId,
        startDate,
        endDate,
        initialCapital,
        finalCapital: initialCapital,
        totalReturn: 0,
        totalReturnPct: 0,
        trades: [],
        maxDrawdown: 0,
        maxDrawdownPct: 0,
        sharpeRatio: 0,
        winRate: 0,
        profitFactor: 0,
        avgTrade: 0,
        dailyReturns: [],
      };

      logger.info({ strategyId, startDate, endDate }, 'Backtest started');

      // In production, iterate through historical data and simulate trades
      // For now, return empty result

      logger.info({ strategyId, result: { finalCapital: result.finalCapital, winRate: result.winRate } }, 'Backtest completed');

      return result;
    },
  } as Partial<BotManager>);

  return emitter;
}

// =============================================================================
// BUILT-IN STRATEGIES
// =============================================================================

/**
 * Simple mean reversion strategy
 */
export function createMeanReversionStrategy(config: Partial<StrategyConfig> = {}): Strategy {
  const fullConfig: StrategyConfig = {
    id: config.id || 'mean-reversion',
    name: config.name || 'Mean Reversion',
    description: 'Buy when price drops below average, sell when above',
    platforms: config.platforms || ['polymarket'],
    intervalMs: config.intervalMs || 60000,
    maxPositionSize: config.maxPositionSize || 100,
    stopLossPct: config.stopLossPct || 10,
    takeProfitPct: config.takeProfitPct || 20,
    enabled: config.enabled ?? true,
    dryRun: config.dryRun ?? true,
    params: {
      lookbackPeriod: 20,
      entryThreshold: 2, // Standard deviations
      exitThreshold: 0.5,
      ...config.params,
    },
  };

  const priceHistory = new Map<string, number[]>();

  return {
    config: fullConfig,

    async evaluate(ctx) {
      const signals: Signal[] = [];
      const params = fullConfig.params!;
      const lookback = params.lookbackPeriod as number;
      const entryThreshold = params.entryThreshold as number;

      for (const [key, position] of ctx.positions) {
        const [platform, marketId, outcome] = key.split(':');
        const history = priceHistory.get(key) || [];

        // Add current price to history
        history.push(position.currentPrice);
        if (history.length > lookback) history.shift();
        priceHistory.set(key, history);

        if (history.length < lookback) continue;

        // Calculate mean and std dev
        const mean = history.reduce((a, b) => a + b, 0) / history.length;
        const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length;
        const stdDev = Math.sqrt(variance);

        const zScore = (position.currentPrice - mean) / stdDev;

        // Entry signals
        if (position.shares === 0) {
          if (zScore < -entryThreshold) {
            signals.push({
              type: 'buy',
              platform: platform as Platform,
              marketId,
              outcome,
              price: position.currentPrice,
              sizePct: 5,
              confidence: Math.min(1, Math.abs(zScore) / 3),
              reason: `Price ${zScore.toFixed(2)} std devs below mean`,
            });
          }
        }

        // Exit signals
        if (position.shares > 0) {
          const pnlPct = ((position.currentPrice - position.avgPrice) / position.avgPrice) * 100;

          if (pnlPct <= -(fullConfig.stopLossPct || 10)) {
            signals.push({
              type: 'sell',
              platform: platform as Platform,
              marketId,
              outcome,
              size: position.shares,
              reason: `Stop loss triggered (${pnlPct.toFixed(1)}%)`,
            });
          } else if (pnlPct >= (fullConfig.takeProfitPct || 20)) {
            signals.push({
              type: 'sell',
              platform: platform as Platform,
              marketId,
              outcome,
              size: position.shares,
              reason: `Take profit triggered (${pnlPct.toFixed(1)}%)`,
            });
          } else if (zScore > (params.exitThreshold as number)) {
            signals.push({
              type: 'sell',
              platform: platform as Platform,
              marketId,
              outcome,
              size: position.shares,
              reason: `Mean reversion exit (z=${zScore.toFixed(2)})`,
            });
          }
        }
      }

      return signals;
    },
  };
}

/**
 * Momentum strategy
 */
export function createMomentumStrategy(config: Partial<StrategyConfig> = {}): Strategy {
  const fullConfig: StrategyConfig = {
    id: config.id || 'momentum',
    name: config.name || 'Momentum',
    description: 'Follow price trends',
    platforms: config.platforms || ['polymarket'],
    intervalMs: config.intervalMs || 60000,
    maxPositionSize: config.maxPositionSize || 100,
    stopLossPct: config.stopLossPct || 15,
    takeProfitPct: config.takeProfitPct || 30,
    enabled: config.enabled ?? true,
    dryRun: config.dryRun ?? true,
    params: {
      shortPeriod: 5,
      longPeriod: 20,
      minMomentum: 0.05, // 5% change
      ...config.params,
    },
  };

  const priceHistory = new Map<string, number[]>();

  return {
    config: fullConfig,

    async evaluate(ctx) {
      const signals: Signal[] = [];
      const params = fullConfig.params!;
      const shortPeriod = params.shortPeriod as number;
      const longPeriod = params.longPeriod as number;
      const minMomentum = params.minMomentum as number;

      for (const [key, position] of ctx.positions) {
        const [platform, marketId, outcome] = key.split(':');
        const history = priceHistory.get(key) || [];

        history.push(position.currentPrice);
        if (history.length > longPeriod) history.shift();
        priceHistory.set(key, history);

        if (history.length < longPeriod) continue;

        // Calculate short and long moving averages
        const shortMA = history.slice(-shortPeriod).reduce((a, b) => a + b, 0) / shortPeriod;
        const longMA = history.reduce((a, b) => a + b, 0) / history.length;

        const momentum = (shortMA - longMA) / longMA;

        // Entry: short MA crosses above long MA with sufficient momentum
        if (position.shares === 0 && momentum > minMomentum) {
          signals.push({
            type: 'buy',
            platform: platform as Platform,
            marketId,
            outcome,
            price: position.currentPrice,
            sizePct: 5,
            confidence: Math.min(1, momentum / (minMomentum * 2)),
            reason: `Bullish momentum (${(momentum * 100).toFixed(1)}%)`,
          });
        }

        // Exit: momentum reverses or stop/take profit
        if (position.shares > 0) {
          const pnlPct = ((position.currentPrice - position.avgPrice) / position.avgPrice) * 100;

          if (pnlPct <= -(fullConfig.stopLossPct || 15)) {
            signals.push({
              type: 'sell',
              platform: platform as Platform,
              marketId,
              outcome,
              size: position.shares,
              reason: `Stop loss (${pnlPct.toFixed(1)}%)`,
            });
          } else if (pnlPct >= (fullConfig.takeProfitPct || 30)) {
            signals.push({
              type: 'sell',
              platform: platform as Platform,
              marketId,
              outcome,
              size: position.shares,
              reason: `Take profit (${pnlPct.toFixed(1)}%)`,
            });
          } else if (momentum < -minMomentum) {
            signals.push({
              type: 'sell',
              platform: platform as Platform,
              marketId,
              outcome,
              size: position.shares,
              reason: `Momentum reversal (${(momentum * 100).toFixed(1)}%)`,
            });
          }
        }
      }

      return signals;
    },
  };
}

/**
 * Arbitrage strategy across platforms
 */
export function createArbitrageStrategy(config: Partial<StrategyConfig> = {}): Strategy {
  const fullConfig: StrategyConfig = {
    id: config.id || 'arbitrage',
    name: config.name || 'Cross-Platform Arbitrage',
    description: 'Exploit price differences across platforms',
    platforms: config.platforms || ['polymarket', 'kalshi'],
    intervalMs: config.intervalMs || 10000, // Check every 10 seconds
    maxPositionSize: config.maxPositionSize || 500,
    enabled: config.enabled ?? true,
    dryRun: config.dryRun ?? true,
    params: {
      minSpreadPct: 3, // Minimum 3% spread
      maxExposure: 1000,
      ...config.params,
    },
  };

  return {
    config: fullConfig,

    async evaluate(ctx) {
      const signals: Signal[] = [];
      // Arbitrage logic would compare prices across markets
      // This is a simplified placeholder
      return signals;
    },
  };
}

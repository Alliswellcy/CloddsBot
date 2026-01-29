/**
 * Portfolio Service - Track positions, balances, and PnL
 *
 * Features:
 * - Fetch positions from Polymarket/Kalshi APIs
 * - Calculate unrealized PnL
 * - Track portfolio value over time
 * - Multi-platform aggregation
 */

import { logger } from '../utils/logger';
import { Database } from '../db/index';
import {
  buildPolymarketHeadersForUrl,
  PolymarketApiKeyAuth,
} from '../utils/polymarket-auth';
import {
  buildKalshiHeadersForUrl,
  KalshiApiKeyAuth,
} from '../utils/kalshi-auth';

// =============================================================================
// TYPES
// =============================================================================

export interface Position {
  id: string;
  platform: 'polymarket' | 'kalshi';
  marketId: string;
  marketQuestion?: string;
  outcome: string;
  tokenId?: string;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  value: number;
  costBasis: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
  realizedPnL: number;
}

export interface PortfolioBalance {
  platform: 'polymarket' | 'kalshi';
  available: number;
  locked: number;
  total: number;
}

export interface PortfolioSummary {
  totalValue: number;
  totalCostBasis: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
  realizedPnL: number;
  positionsCount: number;
  balances: PortfolioBalance[];
  positions: Position[];
  lastUpdated: Date;
}

export interface PortfolioConfig {
  polymarket?: PolymarketApiKeyAuth;
  kalshi?: KalshiApiKeyAuth;
  /** Cache TTL in seconds */
  cacheTtlSeconds?: number;
}

export interface PortfolioService {
  /** Fetch all positions from connected platforms */
  fetchPositions(): Promise<Position[]>;

  /** Fetch balances from connected platforms */
  fetchBalances(): Promise<PortfolioBalance[]>;

  /** Get portfolio summary with PnL */
  getSummary(): Promise<PortfolioSummary>;

  /** Get positions for a specific platform */
  getPositionsByPlatform(platform: 'polymarket' | 'kalshi'): Promise<Position[]>;

  /** Get a specific position */
  getPosition(platform: string, marketId: string, outcome: string): Promise<Position | null>;

  /** Calculate total unrealized PnL */
  getUnrealizedPnL(): Promise<number>;

  /** Get total portfolio value */
  getTotalValue(): Promise<number>;

  /** Format portfolio for chat display */
  formatSummary(): Promise<string>;

  /** Format positions table for chat */
  formatPositionsTable(): Promise<string>;

  /** Refresh cache */
  refresh(): Promise<void>;
}

// =============================================================================
// POLYMARKET API
// =============================================================================

const POLY_CLOB_URL = 'https://clob.polymarket.com';
const POLY_GAMMA_URL = 'https://gamma-api.polymarket.com';

interface PolymarketPosition {
  asset: string;
  condition_id: string;
  size: string;
  avgPrice: string;
  cur_price: string;
  pnl?: string;
  realized_pnl?: string;
  market?: string;
  outcome?: string;
}

interface PolymarketBalanceResponse {
  balance: string;
  allowance?: string;
}

async function fetchPolymarketPositions(auth: PolymarketApiKeyAuth): Promise<Position[]> {
  const url = `${POLY_CLOB_URL}/positions`;
  const headers = buildPolymarketHeadersForUrl(auth, 'GET', url);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      logger.error({ status: response.status }, 'Failed to fetch Polymarket positions');
      return [];
    }

    const data = (await response.json()) as PolymarketPosition[];

    return data.map((p) => {
      const shares = parseFloat(p.size);
      const avgPrice = parseFloat(p.avgPrice);
      const currentPrice = parseFloat(p.cur_price);
      const costBasis = shares * avgPrice;
      const value = shares * currentPrice;
      const unrealizedPnL = value - costBasis;
      const unrealizedPnLPct = costBasis > 0 ? (unrealizedPnL / costBasis) * 100 : 0;

      return {
        id: `poly_${p.asset}`,
        platform: 'polymarket' as const,
        marketId: p.condition_id,
        marketQuestion: p.market,
        outcome: p.outcome || 'Unknown',
        tokenId: p.asset,
        shares,
        avgPrice,
        currentPrice,
        value,
        costBasis,
        unrealizedPnL,
        unrealizedPnLPct,
        realizedPnL: parseFloat(p.realized_pnl || '0'),
      };
    });
  } catch (error) {
    logger.error({ error }, 'Error fetching Polymarket positions');
    return [];
  }
}

async function fetchPolymarketBalance(auth: PolymarketApiKeyAuth): Promise<PortfolioBalance> {
  const url = `${POLY_CLOB_URL}/balance`;
  const headers = buildPolymarketHeadersForUrl(auth, 'GET', url);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      logger.error({ status: response.status }, 'Failed to fetch Polymarket balance');
      return { platform: 'polymarket', available: 0, locked: 0, total: 0 };
    }

    const data = (await response.json()) as PolymarketBalanceResponse;
    const available = parseFloat(data.balance) / 1e6; // USDC has 6 decimals

    return {
      platform: 'polymarket',
      available,
      locked: 0, // Would need to calculate from open orders
      total: available,
    };
  } catch (error) {
    logger.error({ error }, 'Error fetching Polymarket balance');
    return { platform: 'polymarket', available: 0, locked: 0, total: 0 };
  }
}

// =============================================================================
// KALSHI API
// =============================================================================

const KALSHI_API_URL = 'https://api.elections.kalshi.com/trade-api/v2';

interface KalshiPosition {
  market_id: string;
  market_title?: string;
  position: number;
  average_price: number;
  resting_orders_count: number;
  realized_pnl: number;
  total_cost: number;
}

interface KalshiBalanceResponse {
  balance: number;
  portfolio_value?: number;
}

async function fetchKalshiPositions(auth: KalshiApiKeyAuth): Promise<Position[]> {
  const url = `${KALSHI_API_URL}/portfolio/positions`;
  const headers = buildKalshiHeadersForUrl(auth, 'GET', url);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      logger.error({ status: response.status }, 'Failed to fetch Kalshi positions');
      return [];
    }

    const data = (await response.json()) as { market_positions: KalshiPosition[] };

    return (data.market_positions || []).map((p) => {
      const shares = Math.abs(p.position);
      const avgPrice = p.average_price / 100; // Kalshi uses cents
      const currentPrice = avgPrice; // Would need separate price fetch
      const costBasis = p.total_cost / 100;
      const value = shares * currentPrice;
      const unrealizedPnL = value - costBasis;
      const unrealizedPnLPct = costBasis > 0 ? (unrealizedPnL / costBasis) * 100 : 0;

      return {
        id: `kalshi_${p.market_id}`,
        platform: 'kalshi' as const,
        marketId: p.market_id,
        marketQuestion: p.market_title,
        outcome: p.position > 0 ? 'Yes' : 'No',
        shares,
        avgPrice,
        currentPrice,
        value,
        costBasis,
        unrealizedPnL,
        unrealizedPnLPct,
        realizedPnL: p.realized_pnl / 100,
      };
    });
  } catch (error) {
    logger.error({ error }, 'Error fetching Kalshi positions');
    return [];
  }
}

async function fetchKalshiBalance(auth: KalshiApiKeyAuth): Promise<PortfolioBalance> {
  const url = `${KALSHI_API_URL}/portfolio/balance`;
  const headers = buildKalshiHeadersForUrl(auth, 'GET', url);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      logger.error({ status: response.status }, 'Failed to fetch Kalshi balance');
      return { platform: 'kalshi', available: 0, locked: 0, total: 0 };
    }

    const data = (await response.json()) as KalshiBalanceResponse;
    const available = data.balance / 100; // Cents to dollars

    return {
      platform: 'kalshi',
      available,
      locked: 0,
      total: available,
    };
  } catch (error) {
    logger.error({ error }, 'Error fetching Kalshi balance');
    return { platform: 'kalshi', available: 0, locked: 0, total: 0 };
  }
}

// =============================================================================
// PORTFOLIO SERVICE
// =============================================================================

export function createPortfolioService(config: PortfolioConfig, db?: Database): PortfolioService {
  const cacheTtl = (config.cacheTtlSeconds || 30) * 1000;
  let cachedPositions: Position[] | null = null;
  let cachedBalances: PortfolioBalance[] | null = null;
  let lastFetch = 0;

  async function refreshIfStale(): Promise<void> {
    if (Date.now() - lastFetch > cacheTtl) {
      await service.refresh();
    }
  }

  const service: PortfolioService = {
    async fetchPositions() {
      const positions: Position[] = [];

      if (config.polymarket) {
        const polyPositions = await fetchPolymarketPositions(config.polymarket);
        positions.push(...polyPositions);
      }

      if (config.kalshi) {
        const kalshiPositions = await fetchKalshiPositions(config.kalshi);
        positions.push(...kalshiPositions);
      }

      cachedPositions = positions;
      lastFetch = Date.now();

      logger.info({ count: positions.length }, 'Fetched positions');
      return positions;
    },

    async fetchBalances() {
      const balances: PortfolioBalance[] = [];

      if (config.polymarket) {
        const polyBalance = await fetchPolymarketBalance(config.polymarket);
        balances.push(polyBalance);
      }

      if (config.kalshi) {
        const kalshiBalance = await fetchKalshiBalance(config.kalshi);
        balances.push(kalshiBalance);
      }

      cachedBalances = balances;
      return balances;
    },

    async getSummary() {
      await refreshIfStale();

      const positions = cachedPositions || [];
      const balances = cachedBalances || [];

      const totalValue = positions.reduce((sum, p) => sum + p.value, 0);
      const totalCostBasis = positions.reduce((sum, p) => sum + p.costBasis, 0);
      const unrealizedPnL = positions.reduce((sum, p) => sum + p.unrealizedPnL, 0);
      const realizedPnL = positions.reduce((sum, p) => sum + p.realizedPnL, 0);
      const unrealizedPnLPct = totalCostBasis > 0 ? (unrealizedPnL / totalCostBasis) * 100 : 0;

      return {
        totalValue,
        totalCostBasis,
        unrealizedPnL,
        unrealizedPnLPct,
        realizedPnL,
        positionsCount: positions.length,
        balances,
        positions,
        lastUpdated: new Date(lastFetch),
      };
    },

    async getPositionsByPlatform(platform) {
      await refreshIfStale();
      return (cachedPositions || []).filter((p) => p.platform === platform);
    },

    async getPosition(platform, marketId, outcome) {
      await refreshIfStale();
      return (
        (cachedPositions || []).find(
          (p) => p.platform === platform && p.marketId === marketId && p.outcome === outcome
        ) || null
      );
    },

    async getUnrealizedPnL() {
      await refreshIfStale();
      return (cachedPositions || []).reduce((sum, p) => sum + p.unrealizedPnL, 0);
    },

    async getTotalValue() {
      await refreshIfStale();
      const positions = cachedPositions || [];
      const balances = cachedBalances || [];

      const positionValue = positions.reduce((sum, p) => sum + p.value, 0);
      const cashValue = balances.reduce((sum, b) => sum + b.available, 0);

      return positionValue + cashValue;
    },

    async formatSummary() {
      const summary = await this.getSummary();
      const pnlSign = summary.unrealizedPnL >= 0 ? '+' : '';
      const pnlEmoji = summary.unrealizedPnL >= 0 ? '🟢' : '🔴';

      let text = `📊 **Portfolio Summary**\n\n`;
      text += `**Total Value:** $${summary.totalValue.toFixed(2)}\n`;
      text += `**Positions:** ${summary.positionsCount}\n`;
      text += `**Unrealized P&L:** ${pnlEmoji} ${pnlSign}$${summary.unrealizedPnL.toFixed(2)} (${pnlSign}${summary.unrealizedPnLPct.toFixed(1)}%)\n`;
      text += `**Realized P&L:** $${summary.realizedPnL.toFixed(2)}\n\n`;

      text += `**Balances:**\n`;
      for (const bal of summary.balances) {
        text += `  ${bal.platform}: $${bal.available.toFixed(2)}\n`;
      }

      text += `\n_Updated: ${summary.lastUpdated.toLocaleTimeString()}_`;

      return text;
    },

    async formatPositionsTable() {
      await refreshIfStale();
      const positions = cachedPositions || [];

      if (positions.length === 0) {
        return '📭 No open positions';
      }

      let text = `📈 **Open Positions** (${positions.length})\n\n`;

      for (const pos of positions) {
        const pnlSign = pos.unrealizedPnL >= 0 ? '+' : '';
        const pnlEmoji = pos.unrealizedPnL >= 0 ? '🟢' : '🔴';
        const question = pos.marketQuestion
          ? pos.marketQuestion.slice(0, 40) + (pos.marketQuestion.length > 40 ? '...' : '')
          : pos.marketId.slice(0, 20);

        text += `**${question}**\n`;
        text += `  ${pos.outcome}: ${pos.shares.toFixed(2)} @ $${pos.currentPrice.toFixed(3)}\n`;
        text += `  ${pnlEmoji} ${pnlSign}$${pos.unrealizedPnL.toFixed(2)} (${pnlSign}${pos.unrealizedPnLPct.toFixed(1)}%)\n\n`;
      }

      return text;
    },

    async refresh() {
      await Promise.all([this.fetchPositions(), this.fetchBalances()]);
      logger.info('Portfolio refreshed');
    },
  };

  return service;
}

export { PolymarketApiKeyAuth, KalshiApiKeyAuth };

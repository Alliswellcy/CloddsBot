/**
 * Opportunity Analytics - Track and analyze opportunity performance
 *
 * Features:
 * - Opportunity discovery tracking
 * - Win/loss recording
 * - Platform pair analysis
 * - Historical performance stats
 * - Pattern detection
 */

import type { Database } from '../db/index';
import type { Platform } from '../types';
import { logger } from '../utils/logger';

// =============================================================================
// TYPES
// =============================================================================

export interface OpportunityRecord {
  id: string;
  type: 'internal' | 'cross_platform' | 'edge';
  markets: string; // JSON string
  edgePct: number;
  profitPer100: number;
  score: number;
  confidence: number;
  totalLiquidity: number;
  status: 'active' | 'taken' | 'expired' | 'closed';
  discoveredAt: Date;
  expiresAt: Date;
  taken: boolean;
  fillPrices?: Record<string, number>;
  realizedPnL?: number;
  closedAt?: Date;
  notes?: string;
}

export interface OpportunityStats {
  totalFound: number;
  taken: number;
  winRate: number;
  totalProfit: number;
  avgEdge: number;
  avgScore: number;
  bestPlatformPair?: {
    platforms: [Platform, Platform];
    winRate: number;
    profit: number;
    count: number;
  };
  byType: Record<string, {
    count: number;
    taken: number;
    winRate: number;
    profit: number;
    avgEdge: number;
  }>;
  byPlatform: Record<Platform, {
    count: number;
    taken: number;
    winRate: number;
    profit: number;
  }>;
}

export interface PlatformPairStats {
  platforms: [Platform, Platform];
  count: number;
  taken: number;
  wins: number;
  totalProfit: number;
  avgEdge: number;
  winRate: number;
}

export interface OpportunityAnalytics {
  /** Record an opportunity discovery */
  recordDiscovery(opportunity: OpportunityInput): void;

  /** Record an opportunity was taken */
  recordTaken(opportunity: OpportunityInput): void;

  /** Record opportunity expiry */
  recordExpiry(opportunity: OpportunityInput): void;

  /** Record final outcome */
  recordOutcome(opportunity: OpportunityInput): void;

  /** Get opportunity by ID */
  getOpportunity(id: string): OpportunityRecord | undefined;

  /** Get stats */
  getStats(options?: { days?: number; platform?: Platform; type?: string }): OpportunityStats;

  /** Get platform pair statistics */
  getPlatformPairs(): PlatformPairStats[];

  /** Get opportunities by filters */
  getOpportunities(filters?: {
    type?: string;
    status?: string;
    platform?: Platform;
    minEdge?: number;
    since?: Date;
    limit?: number;
  }): OpportunityRecord[];

  /** Get best performing strategies */
  getBestStrategies(options?: { days?: number; minSamples?: number }): Array<{
    type: string;
    platformPair?: [Platform, Platform];
    winRate: number;
    avgProfit: number;
    samples: number;
  }>;

  /** Cleanup old records */
  cleanup(olderThanDays?: number): number;
}

interface OpportunityInput {
  id: string;
  type: 'internal' | 'cross_platform' | 'edge';
  markets: Array<{
    platform: Platform;
    marketId: string;
    [key: string]: unknown;
  }>;
  edgePct: number;
  profitPer100: number;
  score: number;
  confidence: number;
  totalLiquidity: number;
  status: 'active' | 'taken' | 'expired' | 'closed';
  discoveredAt: Date;
  expiresAt: Date;
  outcome?: {
    taken: boolean;
    fillPrices?: Record<string, number>;
    realizedPnL?: number;
    closedAt?: Date;
    notes?: string;
  };
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function createOpportunityAnalytics(db: Database): OpportunityAnalytics {
  function recordDiscovery(opportunity: OpportunityInput): void {
    try {
      db.run(
        `INSERT OR REPLACE INTO opportunities
         (id, type, markets, edge_pct, profit_per_100, score, confidence,
          total_liquidity, status, discovered_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          opportunity.id,
          opportunity.type,
          JSON.stringify(opportunity.markets),
          opportunity.edgePct,
          opportunity.profitPer100,
          opportunity.score,
          opportunity.confidence,
          opportunity.totalLiquidity,
          'active',
          opportunity.discoveredAt.getTime(),
          opportunity.expiresAt.getTime(),
        ]
      );

      // Update platform pair stats
      updatePlatformPairStats(opportunity, 'discovery');
    } catch (error) {
      logger.warn({ error, id: opportunity.id }, 'Failed to record discovery');
    }
  }

  function recordTaken(opportunity: OpportunityInput): void {
    try {
      const fillPrices = opportunity.outcome?.fillPrices
        ? JSON.stringify(opportunity.outcome.fillPrices)
        : null;

      db.run(
        `UPDATE opportunities
         SET status = 'taken', taken = 1, fill_prices = ?
         WHERE id = ?`,
        [fillPrices, opportunity.id]
      );

      // Update platform pair stats
      updatePlatformPairStats(opportunity, 'taken');
    } catch (error) {
      logger.warn({ error, id: opportunity.id }, 'Failed to record taken');
    }
  }

  function recordExpiry(opportunity: OpportunityInput): void {
    try {
      db.run(
        `UPDATE opportunities SET status = 'expired' WHERE id = ?`,
        [opportunity.id]
      );
    } catch (error) {
      logger.warn({ error, id: opportunity.id }, 'Failed to record expiry');
    }
  }

  function recordOutcome(opportunity: OpportunityInput): void {
    try {
      const outcome = opportunity.outcome;
      if (!outcome) return;

      const fillPrices = outcome.fillPrices ? JSON.stringify(outcome.fillPrices) : null;

      db.run(
        `UPDATE opportunities
         SET status = 'closed',
             taken = ?,
             fill_prices = ?,
             realized_pnl = ?,
             closed_at = ?,
             notes = ?
         WHERE id = ?`,
        [
          outcome.taken ? 1 : 0,
          fillPrices,
          outcome.realizedPnL || null,
          outcome.closedAt?.getTime() || Date.now(),
          outcome.notes || null,
          opportunity.id,
        ]
      );

      // Update platform pair stats with outcome
      if (outcome.taken && outcome.realizedPnL !== undefined) {
        updatePlatformPairStats(opportunity, outcome.realizedPnL >= 0 ? 'win' : 'loss', outcome.realizedPnL);
      }
    } catch (error) {
      logger.warn({ error, id: opportunity.id }, 'Failed to record outcome');
    }
  }

  function updatePlatformPairStats(
    opportunity: OpportunityInput,
    event: 'discovery' | 'taken' | 'win' | 'loss',
    profit?: number
  ): void {
    if (opportunity.type !== 'cross_platform' || opportunity.markets.length < 2) {
      return;
    }

    const platforms = opportunity.markets
      .map((m) => m.platform)
      .sort() as [Platform, Platform];

    const [platformA, platformB] = platforms;

    try {
      // Ensure row exists
      db.run(
        `INSERT OR IGNORE INTO platform_pair_stats (platform_a, platform_b)
         VALUES (?, ?)`,
        [platformA, platformB]
      );

      switch (event) {
        case 'discovery':
          db.run(
            `UPDATE platform_pair_stats
             SET total_opportunities = total_opportunities + 1,
                 avg_edge = (avg_edge * total_opportunities + ?) / (total_opportunities + 1),
                 last_updated = ?
             WHERE platform_a = ? AND platform_b = ?`,
            [opportunity.edgePct, Date.now(), platformA, platformB]
          );
          break;

        case 'taken':
          db.run(
            `UPDATE platform_pair_stats
             SET taken = taken + 1, last_updated = ?
             WHERE platform_a = ? AND platform_b = ?`,
            [Date.now(), platformA, platformB]
          );
          break;

        case 'win':
          db.run(
            `UPDATE platform_pair_stats
             SET wins = wins + 1, total_profit = total_profit + ?, last_updated = ?
             WHERE platform_a = ? AND platform_b = ?`,
            [profit || 0, Date.now(), platformA, platformB]
          );
          break;

        case 'loss':
          db.run(
            `UPDATE platform_pair_stats
             SET total_profit = total_profit + ?, last_updated = ?
             WHERE platform_a = ? AND platform_b = ?`,
            [profit || 0, Date.now(), platformA, platformB]
          );
          break;
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to update platform pair stats');
    }
  }

  function getOpportunity(id: string): OpportunityRecord | undefined {
    try {
      const rows = db.query<{
        id: string;
        type: string;
        markets: string;
        edge_pct: number;
        profit_per_100: number;
        score: number;
        confidence: number;
        total_liquidity: number;
        status: string;
        discovered_at: number;
        expires_at: number;
        taken: number;
        fill_prices: string | null;
        realized_pnl: number | null;
        closed_at: number | null;
        notes: string | null;
      }>(
        'SELECT * FROM opportunities WHERE id = ?',
        [id]
      );

      if (rows.length === 0) return undefined;

      const row = rows[0];
      return {
        id: row.id,
        type: row.type as OpportunityRecord['type'],
        markets: row.markets,
        edgePct: row.edge_pct,
        profitPer100: row.profit_per_100,
        score: row.score,
        confidence: row.confidence,
        totalLiquidity: row.total_liquidity,
        status: row.status as OpportunityRecord['status'],
        discoveredAt: new Date(row.discovered_at),
        expiresAt: new Date(row.expires_at),
        taken: row.taken === 1,
        fillPrices: row.fill_prices ? JSON.parse(row.fill_prices) : undefined,
        realizedPnL: row.realized_pnl ?? undefined,
        closedAt: row.closed_at ? new Date(row.closed_at) : undefined,
        notes: row.notes ?? undefined,
      };
    } catch (error) {
      logger.warn({ error, id }, 'Failed to get opportunity');
      return undefined;
    }
  }

  function getStats(options?: {
    days?: number;
    platform?: Platform;
    type?: string;
  }): OpportunityStats {
    const { days = 30, platform, type } = options || {};

    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
      // Build query
      let whereClause = 'WHERE discovered_at > ?';
      const params: unknown[] = [sinceMs];

      if (type) {
        whereClause += ' AND type = ?';
        params.push(type);
      }

      if (platform) {
        whereClause += ' AND markets LIKE ?';
        params.push(`%"platform":"${platform}"%`);
      }

      // Get totals
      const totals = db.query<{
        total: number;
        taken: number;
        wins: number;
        total_profit: number;
        avg_edge: number;
        avg_score: number;
      }>(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN taken = 1 THEN 1 ELSE 0 END) as taken,
           SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(COALESCE(realized_pnl, 0)) as total_profit,
           AVG(edge_pct) as avg_edge,
           AVG(score) as avg_score
         FROM opportunities ${whereClause}`,
        params
      );

      const total = totals[0] || {
        total: 0,
        taken: 0,
        wins: 0,
        total_profit: 0,
        avg_edge: 0,
        avg_score: 0,
      };

      // Get by type
      const byTypeRows = db.query<{
        type: string;
        count: number;
        taken: number;
        wins: number;
        profit: number;
        avg_edge: number;
      }>(
        `SELECT
           type,
           COUNT(*) as count,
           SUM(CASE WHEN taken = 1 THEN 1 ELSE 0 END) as taken,
           SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(COALESCE(realized_pnl, 0)) as profit,
           AVG(edge_pct) as avg_edge
         FROM opportunities ${whereClause}
         GROUP BY type`,
        params
      );

      const byType: OpportunityStats['byType'] = {};
      for (const row of byTypeRows) {
        byType[row.type] = {
          count: row.count,
          taken: row.taken,
          winRate: row.taken > 0 ? (row.wins / row.taken) * 100 : 0,
          profit: row.profit,
          avgEdge: row.avg_edge,
        };
      }

      // Get by platform (approximate from JSON)
      const byPlatform: OpportunityStats['byPlatform'] = {} as OpportunityStats['byPlatform'];

      // Get best platform pair
      const pairRows = db.query<{
        platform_a: string;
        platform_b: string;
        total_opportunities: number;
        taken: number;
        wins: number;
        total_profit: number;
      }>(
        `SELECT * FROM platform_pair_stats
         WHERE taken > 0
         ORDER BY (CAST(wins AS REAL) / taken) DESC, total_profit DESC
         LIMIT 1`
      );

      let bestPlatformPair: OpportunityStats['bestPlatformPair'];
      if (pairRows.length > 0) {
        const pair = pairRows[0];
        bestPlatformPair = {
          platforms: [pair.platform_a as Platform, pair.platform_b as Platform],
          winRate: pair.taken > 0 ? (pair.wins / pair.taken) * 100 : 0,
          profit: pair.total_profit,
          count: pair.total_opportunities,
        };
      }

      return {
        totalFound: total.total,
        taken: total.taken,
        winRate: total.taken > 0 ? (total.wins / total.taken) * 100 : 0,
        totalProfit: total.total_profit,
        avgEdge: total.avg_edge,
        avgScore: total.avg_score,
        bestPlatformPair,
        byType,
        byPlatform,
      };
    } catch (error) {
      logger.warn({ error }, 'Failed to get stats');
      return {
        totalFound: 0,
        taken: 0,
        winRate: 0,
        totalProfit: 0,
        avgEdge: 0,
        avgScore: 0,
        byType: {},
        byPlatform: {} as OpportunityStats['byPlatform'],
      };
    }
  }

  function getPlatformPairs(): PlatformPairStats[] {
    try {
      const rows = db.query<{
        platform_a: string;
        platform_b: string;
        total_opportunities: number;
        taken: number;
        wins: number;
        total_profit: number;
        avg_edge: number;
      }>(
        `SELECT * FROM platform_pair_stats
         WHERE total_opportunities > 0
         ORDER BY total_opportunities DESC`
      );

      return rows.map((row) => ({
        platforms: [row.platform_a as Platform, row.platform_b as Platform],
        count: row.total_opportunities,
        taken: row.taken,
        wins: row.wins,
        totalProfit: row.total_profit,
        avgEdge: row.avg_edge,
        winRate: row.taken > 0 ? (row.wins / row.taken) * 100 : 0,
      }));
    } catch (error) {
      logger.warn({ error }, 'Failed to get platform pairs');
      return [];
    }
  }

  function getOpportunities(filters?: {
    type?: string;
    status?: string;
    platform?: Platform;
    minEdge?: number;
    since?: Date;
    limit?: number;
  }): OpportunityRecord[] {
    const { type, status, platform, minEdge, since, limit = 100 } = filters || {};

    try {
      let whereClause = 'WHERE 1=1';
      const params: unknown[] = [];

      if (type) {
        whereClause += ' AND type = ?';
        params.push(type);
      }

      if (status) {
        whereClause += ' AND status = ?';
        params.push(status);
      }

      if (platform) {
        whereClause += ' AND markets LIKE ?';
        params.push(`%"platform":"${platform}"%`);
      }

      if (minEdge !== undefined) {
        whereClause += ' AND edge_pct >= ?';
        params.push(minEdge);
      }

      if (since) {
        whereClause += ' AND discovered_at >= ?';
        params.push(since.getTime());
      }

      params.push(limit);

      const rows = db.query<{
        id: string;
        type: string;
        markets: string;
        edge_pct: number;
        profit_per_100: number;
        score: number;
        confidence: number;
        total_liquidity: number;
        status: string;
        discovered_at: number;
        expires_at: number;
        taken: number;
        fill_prices: string | null;
        realized_pnl: number | null;
        closed_at: number | null;
        notes: string | null;
      }>(
        `SELECT * FROM opportunities ${whereClause}
         ORDER BY discovered_at DESC LIMIT ?`,
        params
      );

      return rows.map((row) => ({
        id: row.id,
        type: row.type as OpportunityRecord['type'],
        markets: row.markets,
        edgePct: row.edge_pct,
        profitPer100: row.profit_per_100,
        score: row.score,
        confidence: row.confidence,
        totalLiquidity: row.total_liquidity,
        status: row.status as OpportunityRecord['status'],
        discoveredAt: new Date(row.discovered_at),
        expiresAt: new Date(row.expires_at),
        taken: row.taken === 1,
        fillPrices: row.fill_prices ? JSON.parse(row.fill_prices) : undefined,
        realizedPnL: row.realized_pnl ?? undefined,
        closedAt: row.closed_at ? new Date(row.closed_at) : undefined,
        notes: row.notes ?? undefined,
      }));
    } catch (error) {
      logger.warn({ error }, 'Failed to get opportunities');
      return [];
    }
  }

  function getBestStrategies(options?: {
    days?: number;
    minSamples?: number;
  }): Array<{
    type: string;
    platformPair?: [Platform, Platform];
    winRate: number;
    avgProfit: number;
    samples: number;
  }> {
    const { days = 30, minSamples = 5 } = options || {};
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
      // Get by type
      const byType = db.query<{
        type: string;
        samples: number;
        wins: number;
        avg_profit: number;
      }>(
        `SELECT
           type,
           COUNT(*) as samples,
           SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
           AVG(COALESCE(realized_pnl, 0)) as avg_profit
         FROM opportunities
         WHERE taken = 1 AND discovered_at > ? AND status = 'closed'
         GROUP BY type
         HAVING COUNT(*) >= ?
         ORDER BY (CAST(wins AS REAL) / COUNT(*)) DESC`,
        [sinceMs, minSamples]
      );

      const results: Array<{
        type: string;
        platformPair?: [Platform, Platform];
        winRate: number;
        avgProfit: number;
        samples: number;
      }> = byType.map((row) => ({
        type: row.type,
        winRate: row.samples > 0 ? (row.wins / row.samples) * 100 : 0,
        avgProfit: row.avg_profit,
        samples: row.samples,
      }));

      // Add platform pairs
      const pairs = db.query<{
        platform_a: string;
        platform_b: string;
        taken: number;
        wins: number;
        total_profit: number;
      }>(
        `SELECT * FROM platform_pair_stats
         WHERE taken >= ?
         ORDER BY (CAST(wins AS REAL) / taken) DESC`,
        [minSamples]
      );

      for (const pair of pairs) {
        results.push({
          type: 'cross_platform',
          platformPair: [pair.platform_a as Platform, pair.platform_b as Platform],
          winRate: pair.taken > 0 ? (pair.wins / pair.taken) * 100 : 0,
          avgProfit: pair.taken > 0 ? pair.total_profit / pair.taken : 0,
          samples: pair.taken,
        });
      }

      return results.sort((a, b) => b.winRate - a.winRate);
    } catch (error) {
      logger.warn({ error }, 'Failed to get best strategies');
      return [];
    }
  }

  function cleanup(olderThanDays = 90): number {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

    try {
      // Count before deletion
      const before = db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM opportunities WHERE discovered_at < ? AND status IN ('expired', 'closed')`,
        [cutoff]
      );
      const toDelete = before[0]?.count || 0;

      db.run(
        `DELETE FROM opportunities WHERE discovered_at < ? AND status IN ('expired', 'closed')`,
        [cutoff]
      );

      logger.info({ deleted: toDelete, olderThanDays }, 'Cleaned up old opportunities');
      return toDelete;
    } catch (error) {
      logger.warn({ error }, 'Failed to cleanup opportunities');
      return 0;
    }
  }

  return {
    recordDiscovery,
    recordTaken,
    recordExpiry,
    recordOutcome,
    getOpportunity,
    getStats,
    getPlatformPairs,
    getOpportunities,
    getBestStrategies,
    cleanup,
  };
}

/**
 * Trading API Routes — REST endpoints for positions, portfolio, orders,
 * signals, strategies, and orchestrator status.
 *
 * Mounted as a single Express Router via httpGateway.setTradingApiRouter().
 * All endpoints are prefixed with /api by the caller.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import type { Database } from '../db/index.js';
import type { ExecutionService } from '../execution/index.js';
import type { TradingOrchestrator, OrchestratorStats } from '../trading/orchestrator.js';
import type { SafetyManager, SafetyState } from '../trading/safety.js';
import type { SignalRouter } from '../signal-router/index.js';
import type { BotManager, BotStatus } from '../trading/bots/index.js';
import type { TradeLogger } from '../trading/logger.js';
import type { Platform } from '../types.js';

// ── Dependencies ────────────────────────────────────────────────────────────

export interface TradingApiDeps {
  db: Database;
  execution: ExecutionService | null;
  orchestrator: TradingOrchestrator | null;
  safety: SafetyManager | null;
  signalRouter: SignalRouter | null;
  botManager: BotManager | null;
  tradeLogger: TradeLogger | null;
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createTradingApiRouter(deps: TradingApiDeps): Router {
  const router = Router();
  const { db, execution, orchestrator, safety, signalRouter, botManager, tradeLogger } = deps;

  // ── GET /api/positions ──────────────────────────────────────────────────
  // Returns all tracked positions from DB
  router.get('/positions', (_req: Request, res: Response) => {
    try {
      const userId = 'default';
      const positions = db.getPositions(userId);
      res.json({ positions, count: positions.length });
    } catch (err) {
      logger.warn({ err }, 'API: Failed to get positions');
      res.status(500).json({ error: 'Failed to fetch positions' });
    }
  });

  // ── GET /api/portfolio ──────────────────────────────────────────────────
  // Portfolio summary: value, balance, positions with PnL
  router.get('/portfolio', (_req: Request, res: Response) => {
    try {
      const userId = 'default';
      const positions = db.getPositions(userId);

      let totalValue = 0;
      let totalCost = 0;
      let unrealizedPnL = 0;

      const positionSummaries = positions.map((p: any) => {
        const value = p.shares * (p.currentPrice || p.avgPrice);
        const cost = p.shares * p.avgPrice;
        const pnl = value - cost;
        const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;

        totalValue += value;
        totalCost += cost;
        unrealizedPnL += pnl;

        return {
          id: p.id,
          platform: p.platform,
          marketId: p.marketId,
          marketQuestion: p.marketQuestion,
          outcome: p.outcome,
          shares: p.shares,
          avgPrice: p.avgPrice,
          currentPrice: p.currentPrice || p.avgPrice,
          value: Math.round(value * 100) / 100,
          pnl: Math.round(pnl * 100) / 100,
          pnlPct: Math.round(pnlPct * 10) / 10,
        };
      });

      res.json({
        totalValue: Math.round(totalValue * 100) / 100,
        totalCost: Math.round(totalCost * 100) / 100,
        unrealizedPnL: Math.round(unrealizedPnL * 100) / 100,
        positionCount: positions.length,
        positions: positionSummaries,
      });
    } catch (err) {
      logger.warn({ err }, 'API: Failed to get portfolio');
      res.status(500).json({ error: 'Failed to fetch portfolio' });
    }
  });

  // ── GET /api/orders ─────────────────────────────────────────────────────
  // Open orders + recent fills from execution service
  router.get('/orders', async (req: Request, res: Response) => {
    if (!execution) {
      res.status(404).json({ error: 'Execution service not available' });
      return;
    }

    try {
      const platform = (req.query.platform as string) || 'polymarket';

      const openOrders = await execution.getOpenOrders(platform as any);
      const recentFills = execution.getTrackedFills
        ? execution.getTrackedFills()
        : [];

      res.json({
        openOrders: openOrders || [],
        recentFills: recentFills || [],
        openCount: openOrders?.length || 0,
        fillCount: recentFills?.length || 0,
      });
    } catch (err) {
      logger.warn({ err }, 'API: Failed to get orders');
      res.status(500).json({ error: 'Failed to fetch orders' });
    }
  });

  // ── GET /api/signals/recent ─────────────────────────────────────────────
  // Recent signal executions from signal router
  router.get('/signals/recent', (req: Request, res: Response) => {
    if (!signalRouter) {
      res.status(404).json({ error: 'Signal router not enabled' });
      return;
    }

    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const executions = signalRouter.getRecentExecutions(limit);
      const stats = signalRouter.getStats();

      res.json({
        executions,
        stats,
        count: executions.length,
      });
    } catch (err) {
      logger.warn({ err }, 'API: Failed to get signals');
      res.status(500).json({ error: 'Failed to fetch signals' });
    }
  });

  // ── GET /api/orchestrator ───────────────────────────────────────────────
  // Orchestrator stats + safety state + circuit breaker status
  router.get('/orchestrator', (_req: Request, res: Response) => {
    try {
      const orchestratorStats: OrchestratorStats | null = orchestrator?.getStats() ?? null;
      const safetyState: SafetyState | null = safety?.getState() ?? null;
      const circuitBreakerState = execution?.getCircuitBreakerState?.() ?? null;

      res.json({
        orchestrator: orchestratorStats
          ? {
              paused: orchestrator?.paused ?? false,
              ...orchestratorStats,
            }
          : null,
        safety: safetyState,
        circuitBreaker: circuitBreakerState,
      });
    } catch (err) {
      logger.warn({ err }, 'API: Failed to get orchestrator status');
      res.status(500).json({ error: 'Failed to fetch orchestrator status' });
    }
  });

  // ── GET /api/strategies ─────────────────────────────────────────────────
  // Registered bot strategies and their statuses
  router.get('/strategies', (_req: Request, res: Response) => {
    if (!botManager) {
      res.status(404).json({ error: 'Bot manager not available' });
      return;
    }

    try {
      const strategies = botManager.getStrategies();
      const statuses: BotStatus[] = botManager.getAllBotStatuses();

      const combined = strategies.map((cfg) => {
        const status = statuses.find((s) => s.id === cfg.id);
        return {
          id: cfg.id,
          name: cfg.name,
          description: cfg.description,
          platforms: cfg.platforms,
          intervalMs: cfg.intervalMs,
          dryRun: cfg.dryRun,
          status: status?.status || 'stopped',
          tradesCount: status?.tradesCount || 0,
          totalPnL: status?.totalPnL || 0,
          winRate: status?.winRate || 0,
          lastCheck: status?.lastCheck || null,
          lastError: status?.lastError || null,
        };
      });

      res.json({
        strategies: combined,
        count: combined.length,
        running: combined.filter((s) => s.status === 'running').length,
      });
    } catch (err) {
      logger.warn({ err }, 'API: Failed to get strategies');
      res.status(500).json({ error: 'Failed to fetch strategies' });
    }
  });

  // ── GET /api/trades ─────────────────────────────────────────────────────
  // Recent trades from trade logger
  router.get('/trades', (req: Request, res: Response) => {
    if (!tradeLogger) {
      res.status(404).json({ error: 'Trade logger not available' });
      return;
    }

    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const platform = req.query.platform as string | undefined;
      const strategyId = req.query.strategyId as string | undefined;
      const status = req.query.status as string | undefined;

      const trades = tradeLogger.getTrades({
        limit,
        platform: platform as Platform | undefined,
        strategyId,
        status: status as any,
      });
      const stats = tradeLogger.getStats({
        platform: platform as Platform | undefined,
        strategyId,
      });

      res.json({
        trades,
        stats,
        count: trades.length,
      });
    } catch (err) {
      logger.warn({ err }, 'API: Failed to get trades');
      res.status(500).json({ error: 'Failed to fetch trades' });
    }
  });

  // ── GET /api/pnl ────────────────────────────────────────────────────────
  // Daily PnL breakdown
  router.get('/pnl', (req: Request, res: Response) => {
    if (!tradeLogger) {
      res.status(404).json({ error: 'Trade logger not available' });
      return;
    }

    try {
      const days = parseInt(req.query.days as string) || 30;
      const dailyPnl = tradeLogger.getDailyPnL(days);
      const totalPnl = dailyPnl.reduce((sum, d) => sum + d.pnl, 0);
      const totalTrades = dailyPnl.reduce((sum, d) => sum + d.trades, 0);
      const profitDays = dailyPnl.filter((d) => d.pnl > 0).length;

      res.json({
        dailyPnl,
        totalPnl: Math.round(totalPnl * 100) / 100,
        totalTrades,
        profitDays,
        totalDays: dailyPnl.length,
        days,
      });
    } catch (err) {
      logger.warn({ err }, 'API: Failed to get PnL');
      res.status(500).json({ error: 'Failed to fetch PnL data' });
    }
  });

  // ── POST /api/orders ────────────────────────────────────────────────────
  // Submit a new order through the orchestrator
  router.post('/orders', async (req: Request, res: Response) => {
    if (!execution) {
      res.status(404).json({ error: 'Execution service not available' });
      return;
    }

    try {
      const { platform, marketId, tokenId, outcome, side, price, size, orderType, negRisk } = req.body;

      if (!platform || !marketId || !side || !price || !size) {
        res.status(400).json({
          error: 'Missing required fields: platform, marketId, side, price, size',
        });
        return;
      }

      const orderRequest = {
        platform: platform as 'polymarket' | 'kalshi' | 'opinion' | 'predictfun',
        marketId,
        tokenId,
        outcome,
        side: side as 'buy' | 'sell',
        price: Number(price),
        size: Number(size),
        orderType: orderType || 'GTC',
        negRisk: negRisk ?? undefined,
      };

      const result = side === 'buy'
        ? await execution.buyLimit(orderRequest)
        : await execution.sellLimit(orderRequest);

      res.json({
        success: result.success,
        orderId: result.orderId,
        status: result.status,
        filledSize: result.filledSize,
        avgFillPrice: result.avgFillPrice,
        error: result.error,
      });
    } catch (err: any) {
      logger.warn({ err }, 'API: Failed to submit order');
      res.status(500).json({ error: err?.message || 'Failed to submit order' });
    }
  });

  // ── POST /api/orchestrator/pause ────────────────────────────────────────
  router.post('/orchestrator/pause', (req: Request, res: Response) => {
    if (!orchestrator) {
      res.status(404).json({ error: 'Orchestrator not available' });
      return;
    }
    const reason = req.body?.reason || 'Paused via API';
    orchestrator.pause(reason);
    res.json({ success: true, paused: true, reason });
  });

  // ── POST /api/orchestrator/resume ───────────────────────────────────────
  router.post('/orchestrator/resume', (_req: Request, res: Response) => {
    if (!orchestrator) {
      res.status(404).json({ error: 'Orchestrator not available' });
      return;
    }
    orchestrator.resume();
    res.json({ success: true, paused: false });
  });

  // ── POST /api/safety/kill ───────────────────────────────────────────────
  router.post('/safety/kill', (req: Request, res: Response) => {
    if (!safety) {
      res.status(404).json({ error: 'Safety manager not available' });
      return;
    }
    const reason = req.body?.reason || 'Kill switch via API';
    safety.killSwitch(reason);
    res.json({ success: true, tradingEnabled: false, reason });
  });

  // ── POST /api/safety/resume ─────────────────────────────────────────────
  router.post('/safety/resume', (_req: Request, res: Response) => {
    if (!safety) {
      res.status(404).json({ error: 'Safety manager not available' });
      return;
    }
    const resumed = safety.resumeTrading();
    res.json({ success: resumed, tradingEnabled: resumed });
  });

  logger.info('Trading API routes initialized');
  return router;
}

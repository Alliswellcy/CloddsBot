/**
 * Polymarket Whale Tracker
 *
 * Monitors large trades and positions on Polymarket to identify whale activity.
 * Uses a combination of:
 * - CLOB WebSocket for real-time order flow
 * - REST API for position snapshots
 * - Subgraph for historical analysis
 *
 * Use cases:
 * - Copy trading whale positions
 * - Early signal detection for market moves
 * - Liquidity analysis
 */

import { EventEmitter } from 'eventemitter3';
import WebSocket from 'ws';
import { logger } from '../../utils/logger';

// =============================================================================
// TYPES
// =============================================================================

export interface WhaleConfig {
  /** Minimum trade size in $ to be considered a whale (default: 10000) */
  minTradeSize?: number;
  /** Minimum position size in $ to track (default: 50000) */
  minPositionSize?: number;
  /** Market IDs to track (default: all active markets) */
  marketIds?: string[];
  /** Poll interval for position snapshots in ms (default: 60000) */
  pollIntervalMs?: number;
  /** Enable real-time WebSocket tracking (default: true) */
  enableRealtime?: boolean;
}

export interface WhaleTrade {
  id: string;
  timestamp: Date;
  marketId: string;
  marketQuestion?: string;
  tokenId: string;
  outcome: 'Yes' | 'No';
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  usdValue: number;
  maker: string;
  taker: string;
  transactionHash?: string;
}

export interface WhalePosition {
  id: string;
  address: string;
  marketId: string;
  marketQuestion?: string;
  tokenId: string;
  outcome: 'Yes' | 'No';
  size: number;
  avgEntryPrice: number;
  usdValue: number;
  unrealizedPnl?: number;
  lastUpdated: Date;
}

export interface WhaleProfile {
  address: string;
  totalValue: number;
  winRate: number;
  avgReturn: number;
  positions: WhalePosition[];
  recentTrades: WhaleTrade[];
  firstSeen: Date;
  lastActive: Date;
}

export interface WhaleTrackerEvents {
  trade: (trade: WhaleTrade) => void;
  positionOpened: (position: WhalePosition) => void;
  positionClosed: (position: WhalePosition, pnl: number) => void;
  positionChanged: (position: WhalePosition, change: number) => void;
  newWhale: (profile: WhaleProfile) => void;
  error: (error: Error) => void;
}

export interface WhaleTracker extends EventEmitter<keyof WhaleTrackerEvents> {
  start(): Promise<void>;
  stop(): void;
  isRunning(): boolean;
  getKnownWhales(): WhaleProfile[];
  getWhaleProfile(address: string): WhaleProfile | undefined;
  getTopWhales(limit?: number): WhaleProfile[];
  getRecentTrades(limit?: number): WhaleTrade[];
  getActivePositions(marketId?: string): WhalePosition[];
  trackAddress(address: string): void;
  untrackAddress(address: string): void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const CLOB_REST_URL = 'https://clob.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

const DEFAULT_CONFIG: Required<WhaleConfig> = {
  minTradeSize: 10000,
  minPositionSize: 50000,
  marketIds: [],
  pollIntervalMs: 60000,
  enableRealtime: true,
};

// Known whale addresses (can be extended)
const KNOWN_WHALES = new Set<string>([
  // Add known whale addresses here
]);

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function createWhaleTracker(config: WhaleConfig = {}): WhaleTracker {
  const emitter = new EventEmitter() as WhaleTracker;
  const cfg = { ...DEFAULT_CONFIG, ...config };

  let running = false;
  let ws: WebSocket | null = null;
  let pollInterval: NodeJS.Timeout | null = null;
  let reconnectTimeout: NodeJS.Timeout | null = null;

  // State
  const whaleProfiles = new Map<string, WhaleProfile>();
  const activePositions = new Map<string, WhalePosition>();
  const recentTrades: WhaleTrade[] = [];
  const trackedAddresses = new Set<string>(KNOWN_WHALES);

  // ==========================================================================
  // REST API HELPERS
  // ==========================================================================

  async function fetchMarketTrades(marketId: string): Promise<WhaleTrade[]> {
    try {
      const response = await fetch(
        `${CLOB_REST_URL}/trades?market=${marketId}&limit=100`
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as any[];
      return data
        .filter((t) => {
          const usdValue = parseFloat(t.price) * parseFloat(t.size);
          return usdValue >= cfg.minTradeSize;
        })
        .map((t) => ({
          id: t.id || `${t.market}_${t.timestamp}`,
          timestamp: new Date(t.timestamp || t.match_time),
          marketId: t.market || marketId,
          tokenId: t.asset_id,
          outcome: t.outcome || (t.side === 'BUY' ? 'Yes' : 'No'),
          side: t.side?.toUpperCase() || 'BUY',
          price: parseFloat(t.price),
          size: parseFloat(t.size),
          usdValue: parseFloat(t.price) * parseFloat(t.size),
          maker: t.maker_address || t.maker,
          taker: t.taker_address || t.taker,
          transactionHash: t.transaction_hash,
        }));
    } catch (error) {
      logger.error({ marketId, error }, 'Failed to fetch market trades');
      return [];
    }
  }

  async function fetchAddressPositions(address: string): Promise<WhalePosition[]> {
    try {
      const response = await fetch(
        `${GAMMA_API_URL}/positions?address=${address}`
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as any[];
      return data
        .filter((p) => {
          const usdValue = parseFloat(p.currentValue || p.size * p.price || 0);
          return usdValue >= cfg.minPositionSize;
        })
        .map((p) => ({
          id: `${address}_${p.market}_${p.outcome}`,
          address,
          marketId: p.market || p.conditionId,
          marketQuestion: p.title || p.question,
          tokenId: p.asset_id || p.tokenId,
          outcome: p.outcome || 'Yes',
          size: parseFloat(p.size || p.amount || 0),
          avgEntryPrice: parseFloat(p.avgPrice || p.averageBuyPrice || 0),
          usdValue: parseFloat(p.currentValue || p.size * p.price || 0),
          unrealizedPnl: parseFloat(p.pnl || p.unrealizedPnl || 0),
          lastUpdated: new Date(p.updatedAt || Date.now()),
        }));
    } catch (error) {
      logger.error({ address, error }, 'Failed to fetch positions');
      return [];
    }
  }

  async function fetchTopTraders(): Promise<string[]> {
    try {
      const response = await fetch(
        `${GAMMA_API_URL}/leaderboard?limit=100&sortBy=volume`
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as any[];
      return data.map((t) => t.address || t.user);
    } catch (error) {
      logger.error({ error }, 'Failed to fetch top traders');
      return [];
    }
  }

  // ==========================================================================
  // WEBSOCKET HANDLING
  // ==========================================================================

  function connectWebSocket(): void {
    if (ws) {
      ws.close();
    }

    ws = new WebSocket(CLOB_WS_URL);

    ws.on('open', () => {
      logger.info('Whale tracker WebSocket connected');

      // Subscribe to trade events for tracked markets
      const markets = cfg.marketIds.length > 0 ? cfg.marketIds : ['*'];
      for (const marketId of markets) {
        ws?.send(JSON.stringify({
          type: 'subscribe',
          channel: 'trades',
          market: marketId,
        }));
      }
    });

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'trade' || message.event_type === 'trade') {
          handleTradeMessage(message);
        }
      } catch (error) {
        logger.error({ error, data: data.toString().slice(0, 200) }, 'Failed to parse WS message');
      }
    });

    ws.on('close', (code, reason) => {
      logger.info({ code, reason: reason.toString() }, 'Whale tracker WebSocket disconnected');

      if (running) {
        reconnectTimeout = setTimeout(() => {
          logger.info('Reconnecting whale tracker WebSocket');
          connectWebSocket();
        }, 5000);
      }
    });

    ws.on('error', (error) => {
      logger.error({ error }, 'Whale tracker WebSocket error');
      emitter.emit('error', error);
    });
  }

  function handleTradeMessage(message: any): void {
    const price = parseFloat(message.price || 0);
    const size = parseFloat(message.size || message.amount || 0);
    const usdValue = price * size;

    // Filter by minimum size
    if (usdValue < cfg.minTradeSize) {
      return;
    }

    const trade: WhaleTrade = {
      id: message.id || `${message.market}_${Date.now()}`,
      timestamp: new Date(message.timestamp || message.match_time || Date.now()),
      marketId: message.market || message.condition_id,
      marketQuestion: message.question || message.title,
      tokenId: message.asset_id || message.token_id,
      outcome: message.outcome || (message.side === 'BUY' ? 'Yes' : 'No'),
      side: (message.side || 'BUY').toUpperCase(),
      price,
      size,
      usdValue,
      maker: message.maker_address || message.maker || 'unknown',
      taker: message.taker_address || message.taker || 'unknown',
      transactionHash: message.transaction_hash,
    };

    // Track the trade
    recentTrades.unshift(trade);
    if (recentTrades.length > 1000) {
      recentTrades.pop();
    }

    // Check if it's from a tracked whale
    const isKnownWhale = trackedAddresses.has(trade.maker) || trackedAddresses.has(trade.taker);

    logger.info(
      {
        marketId: trade.marketId,
        side: trade.side,
        size: trade.size,
        usdValue: trade.usdValue,
        isKnownWhale,
      },
      'Whale trade detected'
    );

    emitter.emit('trade', trade);

    // Add unknown whales to tracking
    if (!trackedAddresses.has(trade.maker) && trade.usdValue >= cfg.minTradeSize * 5) {
      trackedAddresses.add(trade.maker);
      logger.info({ address: trade.maker }, 'New whale discovered');
    }
    if (!trackedAddresses.has(trade.taker) && trade.usdValue >= cfg.minTradeSize * 5) {
      trackedAddresses.add(trade.taker);
      logger.info({ address: trade.taker }, 'New whale discovered');
    }
  }

  // ==========================================================================
  // POLLING
  // ==========================================================================

  async function pollPositions(): Promise<void> {
    logger.debug({ whaleCount: trackedAddresses.size }, 'Polling whale positions');

    for (const address of trackedAddresses) {
      try {
        const positions = await fetchAddressPositions(address);

        for (const position of positions) {
          const key = position.id;
          const existing = activePositions.get(key);

          if (!existing) {
            // New position
            activePositions.set(key, position);
            emitter.emit('positionOpened', position);
          } else if (Math.abs(position.size - existing.size) > 0.01) {
            // Position changed
            const change = position.size - existing.size;
            activePositions.set(key, position);

            if (position.size === 0) {
              const pnl = position.unrealizedPnl || 0;
              activePositions.delete(key);
              emitter.emit('positionClosed', position, pnl);
            } else {
              emitter.emit('positionChanged', position, change);
            }
          }
        }

        // Update profile
        updateWhaleProfile(address, positions);
      } catch (error) {
        logger.error({ address, error }, 'Failed to poll positions');
      }
    }
  }

  function updateWhaleProfile(address: string, positions: WhalePosition[]): void {
    const existing = whaleProfiles.get(address);
    const totalValue = positions.reduce((sum, p) => sum + p.usdValue, 0);

    const profile: WhaleProfile = {
      address,
      totalValue,
      winRate: existing?.winRate || 0,
      avgReturn: existing?.avgReturn || 0,
      positions,
      recentTrades: recentTrades.filter(
        (t) => t.maker === address || t.taker === address
      ).slice(0, 50),
      firstSeen: existing?.firstSeen || new Date(),
      lastActive: new Date(),
    };

    const isNew = !existing;
    whaleProfiles.set(address, profile);

    if (isNew && totalValue >= cfg.minPositionSize) {
      emitter.emit('newWhale', profile);
    }
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  Object.assign(emitter, {
    async start(): Promise<void> {
      if (running) return;

      running = true;
      logger.info({ config: cfg }, 'Starting whale tracker');

      // Fetch initial top traders
      const topTraders = await fetchTopTraders();
      for (const address of topTraders) {
        trackedAddresses.add(address);
      }

      // Connect WebSocket for real-time trades
      if (cfg.enableRealtime) {
        connectWebSocket();
      }

      // Start position polling
      await pollPositions();
      pollInterval = setInterval(pollPositions, cfg.pollIntervalMs);

      logger.info({ whaleCount: trackedAddresses.size }, 'Whale tracker started');
    },

    stop(): void {
      if (!running) return;

      running = false;

      if (ws) {
        ws.close(1000, 'Stopping');
        ws = null;
      }

      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }

      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }

      logger.info('Whale tracker stopped');
    },

    isRunning(): boolean {
      return running;
    },

    getKnownWhales(): WhaleProfile[] {
      return Array.from(whaleProfiles.values());
    },

    getWhaleProfile(address: string): WhaleProfile | undefined {
      return whaleProfiles.get(address);
    },

    getTopWhales(limit = 10): WhaleProfile[] {
      return Array.from(whaleProfiles.values())
        .sort((a, b) => b.totalValue - a.totalValue)
        .slice(0, limit);
    },

    getRecentTrades(limit = 100): WhaleTrade[] {
      return recentTrades.slice(0, limit);
    },

    getActivePositions(marketId?: string): WhalePosition[] {
      const positions = Array.from(activePositions.values());
      if (marketId) {
        return positions.filter((p) => p.marketId === marketId);
      }
      return positions;
    },

    trackAddress(address: string): void {
      trackedAddresses.add(address);
      logger.info({ address }, 'Now tracking address');
    },

    untrackAddress(address: string): void {
      trackedAddresses.delete(address);
      logger.info({ address }, 'Stopped tracking address');
    },
  } as Partial<WhaleTracker>);

  return emitter;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if an address is likely a whale based on trade history
 */
export async function isWhaleAddress(address: string, minVolume = 100000): Promise<boolean> {
  try {
    const response = await fetch(
      `${GAMMA_API_URL}/user-stats?address=${address}`
    );

    if (!response.ok) {
      return false;
    }

    const stats = await response.json() as any;
    const volume = parseFloat(stats.totalVolume || stats.volume || 0);

    return volume >= minVolume;
  } catch {
    return false;
  }
}

/**
 * Get whale activity summary for a market
 */
export async function getMarketWhaleActivity(
  marketId: string,
  minSize = 10000
): Promise<{
  totalWhaleVolume: number;
  buyVolume: number;
  sellVolume: number;
  topBuyers: string[];
  topSellers: string[];
}> {
  try {
    const response = await fetch(
      `${CLOB_REST_URL}/trades?market=${marketId}&limit=500`
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const trades = await response.json() as any[];

    let buyVolume = 0;
    let sellVolume = 0;
    const buyerVolumes = new Map<string, number>();
    const sellerVolumes = new Map<string, number>();

    for (const trade of trades) {
      const usdValue = parseFloat(trade.price) * parseFloat(trade.size);
      if (usdValue < minSize) continue;

      const maker = trade.maker_address || trade.maker;
      const taker = trade.taker_address || trade.taker;
      const side = trade.side?.toUpperCase();

      if (side === 'BUY') {
        buyVolume += usdValue;
        buyerVolumes.set(taker, (buyerVolumes.get(taker) || 0) + usdValue);
      } else {
        sellVolume += usdValue;
        sellerVolumes.set(taker, (sellerVolumes.get(taker) || 0) + usdValue);
      }
    }

    const topBuyers = Array.from(buyerVolumes.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([addr]) => addr);

    const topSellers = Array.from(sellerVolumes.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([addr]) => addr);

    return {
      totalWhaleVolume: buyVolume + sellVolume,
      buyVolume,
      sellVolume,
      topBuyers,
      topSellers,
    };
  } catch (error) {
    logger.error({ marketId, error }, 'Failed to get market whale activity');
    return {
      totalWhaleVolume: 0,
      buyVolume: 0,
      sellVolume: 0,
      topBuyers: [],
      topSellers: [],
    };
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export { CLOB_WS_URL, CLOB_REST_URL, GAMMA_API_URL, KNOWN_WHALES };

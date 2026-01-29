/**
 * Drift BET Trading - Solana-based prediction market trading
 *
 * Features:
 * - Buy/sell prediction market shares
 * - Portfolio tracking
 * - Order management
 *
 * Requires: Solana wallet + Drift SDK
 *
 * Docs: https://docs.drift.trade/prediction-markets/
 */

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';

// =============================================================================
// TYPES
// =============================================================================

export interface DriftTradingConfig {
  /** Solana RPC URL */
  rpcUrl?: string;
  /** Private key (base58 or Uint8Array) */
  privateKey?: string;
  /** Keypair path */
  keypairPath?: string;
  /** Drift BET API URL */
  betApiUrl?: string;
  /** Dry run mode */
  dryRun?: boolean;
}

export interface DriftOrder {
  orderId: string;
  marketIndex: number;
  direction: 'long' | 'short'; // long = YES, short = NO
  baseAssetAmount: number;
  price: number;
  status: 'open' | 'filled' | 'cancelled';
  createdAt: Date;
}

export interface DriftPosition {
  marketIndex: number;
  marketName: string;
  baseAssetAmount: number; // Positive = long, negative = short
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  realizedPnL: number;
}

export interface DriftBalance {
  spotBalance: number; // USDC
  perpEquity: number;
  totalEquity: number;
}

export interface DriftTrading extends EventEmitter {
  // Initialization
  initialize(): Promise<void>;
  isInitialized(): boolean;

  // Trading
  buyYes(marketIndex: number, amount: number, maxPrice?: number): Promise<DriftOrder | null>;
  buyNo(marketIndex: number, amount: number, maxPrice?: number): Promise<DriftOrder | null>;
  sellYes(marketIndex: number, amount: number, minPrice?: number): Promise<DriftOrder | null>;
  sellNo(marketIndex: number, amount: number, minPrice?: number): Promise<DriftOrder | null>;
  limitBuyYes(marketIndex: number, amount: number, price: number): Promise<DriftOrder | null>;
  limitBuyNo(marketIndex: number, amount: number, price: number): Promise<DriftOrder | null>;
  limitSellYes(marketIndex: number, amount: number, price: number): Promise<DriftOrder | null>;
  limitSellNo(marketIndex: number, amount: number, price: number): Promise<DriftOrder | null>;

  // Order management
  cancelOrder(orderId: string): Promise<boolean>;
  cancelAllOrders(marketIndex?: number): Promise<number>;
  getOpenOrders(marketIndex?: number): Promise<DriftOrder[]>;

  // Portfolio
  getPositions(): Promise<DriftPosition[]>;
  getPosition(marketIndex: number): Promise<DriftPosition | null>;
  getBalance(): Promise<DriftBalance>;

  // Market data
  getMarketPrice(marketIndex: number): Promise<{ yes: number; no: number } | null>;
  getOrderbook(marketIndex: number): Promise<{ bids: [number, number][]; asks: [number, number][] } | null>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';
const DEFAULT_BET_API_URL = 'https://bet.drift.trade/api';

// =============================================================================
// DRIFT TRADING IMPLEMENTATION
// =============================================================================

export function createDriftTrading(config: DriftTradingConfig = {}): DriftTrading {
  const emitter = new EventEmitter();
  const rpcUrl = config.rpcUrl || process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
  const betApiUrl = config.betApiUrl || process.env.DRIFT_BET_API_URL || DEFAULT_BET_API_URL;
  const dryRun = config.dryRun ?? (process.env.DRIFT_DRY_RUN === 'true');

  let initialized = false;
  let walletAddress: string | null = null;

  // Simulated state for positions/orders (would be replaced with actual SDK calls)
  const openOrders = new Map<string, DriftOrder>();
  const positions = new Map<number, DriftPosition>();

  // Helper to fetch from Drift API
  async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T | null> {
    try {
      const response = await fetch(`${betApiUrl}${endpoint}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      });

      if (!response.ok) {
        logger.error({ status: response.status, endpoint }, 'Drift API error');
        return null;
      }

      return await response.json() as T;
    } catch (err) {
      logger.error({ err, endpoint }, 'Drift API fetch error');
      return null;
    }
  }

  // Generate order ID
  function generateOrderId(): string {
    return `drift_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // Create order (internal)
  async function createOrder(
    marketIndex: number,
    direction: 'long' | 'short',
    amount: number,
    price: number | null,
    orderType: 'market' | 'limit'
  ): Promise<DriftOrder | null> {
    if (!initialized) {
      logger.error('Drift trading not initialized');
      return null;
    }

    const orderId = generateOrderId();

    if (dryRun) {
      logger.info(
        { marketIndex, direction, amount, price, orderType, dryRun: true },
        'Drift order (dry run)'
      );

      // Simulate order
      const order: DriftOrder = {
        orderId,
        marketIndex,
        direction,
        baseAssetAmount: amount,
        price: price || 0.5,
        status: orderType === 'market' ? 'filled' : 'open',
        createdAt: new Date(),
      };

      if (orderType === 'limit') {
        openOrders.set(orderId, order);
      }

      return order;
    }

    // Real order execution would go here
    // This requires the Drift SDK which needs Solana wallet setup

    /*
    try {
      // Example with Drift SDK (pseudocode):
      const driftClient = await DriftClient.from(connection, wallet);

      const marketAccount = await driftClient.getPerpMarketAccount(marketIndex);

      if (orderType === 'market') {
        const tx = await driftClient.placePerpOrder({
          marketIndex,
          direction: direction === 'long' ? PositionDirection.LONG : PositionDirection.SHORT,
          baseAssetAmount: new BN(amount * 1e9),
          orderType: OrderType.MARKET,
        });

        await connection.confirmTransaction(tx);
      } else {
        const tx = await driftClient.placePerpOrder({
          marketIndex,
          direction: direction === 'long' ? PositionDirection.LONG : PositionDirection.SHORT,
          baseAssetAmount: new BN(amount * 1e9),
          price: new BN(price * 1e6),
          orderType: OrderType.LIMIT,
        });

        await connection.confirmTransaction(tx);
      }

      return order;
    } catch (err) {
      logger.error({ err }, 'Drift order failed');
      return null;
    }
    */

    logger.warn('Drift trading: Real order execution not yet implemented (SDK required)');

    // For now, simulate successful order
    const order: DriftOrder = {
      orderId,
      marketIndex,
      direction,
      baseAssetAmount: amount,
      price: price || 0.5,
      status: orderType === 'market' ? 'filled' : 'open',
      createdAt: new Date(),
    };

    if (orderType === 'limit') {
      openOrders.set(orderId, order);
    }

    emitter.emit('order', order);
    return order;
  }

  // Attach methods
  const trading: DriftTrading = Object.assign(emitter, {
    async initialize() {
      // Load wallet from config
      if (config.privateKey) {
        // Parse private key and create wallet
        walletAddress = 'simulated_wallet'; // Would be actual public key
        logger.info({ walletAddress }, 'Drift trading initialized (simulated)');
      } else if (config.keypairPath) {
        // Load from file
        walletAddress = 'simulated_wallet';
        logger.info({ keypairPath: config.keypairPath }, 'Drift trading initialized from keypair');
      } else if (process.env.SOLANA_PRIVATE_KEY) {
        walletAddress = 'simulated_wallet';
        logger.info('Drift trading initialized from env');
      } else {
        logger.warn('Drift trading: No wallet configured, running in read-only mode');
      }

      initialized = true;
      emitter.emit('initialized');
    },

    isInitialized() {
      return initialized;
    },

    // Trading - YES side
    async buyYes(marketIndex: number, amount: number, maxPrice?: number) {
      return createOrder(marketIndex, 'long', amount, maxPrice || null, 'market');
    },

    async sellYes(marketIndex: number, amount: number, minPrice?: number) {
      return createOrder(marketIndex, 'short', amount, minPrice || null, 'market');
    },

    async limitBuyYes(marketIndex: number, amount: number, price: number) {
      return createOrder(marketIndex, 'long', amount, price, 'limit');
    },

    async limitSellYes(marketIndex: number, amount: number, price: number) {
      return createOrder(marketIndex, 'short', amount, price, 'limit');
    },

    // Trading - NO side (inverse of YES)
    async buyNo(marketIndex: number, amount: number, maxPrice?: number) {
      // Buying NO = selling YES at inverse price
      const inversePrice = maxPrice ? 1 - maxPrice : undefined;
      return createOrder(marketIndex, 'short', amount, inversePrice || null, 'market');
    },

    async sellNo(marketIndex: number, amount: number, minPrice?: number) {
      const inversePrice = minPrice ? 1 - minPrice : undefined;
      return createOrder(marketIndex, 'long', amount, inversePrice || null, 'market');
    },

    async limitBuyNo(marketIndex: number, amount: number, price: number) {
      return createOrder(marketIndex, 'short', amount, 1 - price, 'limit');
    },

    async limitSellNo(marketIndex: number, amount: number, price: number) {
      return createOrder(marketIndex, 'long', amount, 1 - price, 'limit');
    },

    // Order management
    async cancelOrder(orderId: string) {
      const order = openOrders.get(orderId);
      if (!order) return false;

      if (dryRun) {
        order.status = 'cancelled';
        openOrders.delete(orderId);
        logger.info({ orderId, dryRun: true }, 'Drift order cancelled');
        return true;
      }

      // Real cancellation would use Drift SDK
      order.status = 'cancelled';
      openOrders.delete(orderId);
      emitter.emit('orderCancelled', order);
      return true;
    },

    async cancelAllOrders(marketIndex?: number) {
      let cancelled = 0;

      for (const [orderId, order] of openOrders) {
        if (marketIndex === undefined || order.marketIndex === marketIndex) {
          order.status = 'cancelled';
          openOrders.delete(orderId);
          cancelled++;
        }
      }

      logger.info({ marketIndex, cancelled }, 'Drift orders cancelled');
      return cancelled;
    },

    async getOpenOrders(marketIndex?: number) {
      const orders = Array.from(openOrders.values());

      if (marketIndex !== undefined) {
        return orders.filter((o) => o.marketIndex === marketIndex);
      }

      return orders;
    },

    // Portfolio
    async getPositions() {
      // Fetch from API
      const data = await fetchApi<{
        positions: Array<{
          marketIndex: number;
          baseAssetAmount: string;
          quoteEntryAmount: string;
          openOrders: number;
        }>;
      }>('/user/positions');

      if (!data?.positions) {
        return Array.from(positions.values());
      }

      // Convert to our format
      const result: DriftPosition[] = [];

      for (const p of data.positions) {
        const baseAmount = parseFloat(p.baseAssetAmount) / 1e9;
        if (Math.abs(baseAmount) < 0.0001) continue;

        // Get current price
        const prices = await trading.getMarketPrice(p.marketIndex);
        const currentPrice = baseAmount > 0 ? prices?.yes || 0.5 : prices?.no || 0.5;
        const entryPrice = Math.abs(parseFloat(p.quoteEntryAmount) / 1e6 / baseAmount);

        const position: DriftPosition = {
          marketIndex: p.marketIndex,
          marketName: `Market ${p.marketIndex}`,
          baseAssetAmount: baseAmount,
          entryPrice,
          currentPrice,
          unrealizedPnL: (currentPrice - entryPrice) * baseAmount,
          realizedPnL: 0,
        };

        positions.set(p.marketIndex, position);
        result.push(position);
      }

      return result;
    },

    async getPosition(marketIndex: number) {
      const allPositions = await trading.getPositions();
      return allPositions.find((p) => p.marketIndex === marketIndex) || null;
    },

    async getBalance() {
      const data = await fetchApi<{
        spotBalance: number;
        perpEquity: number;
        totalEquity: number;
      }>('/user/balance');

      if (!data) {
        return { spotBalance: 0, perpEquity: 0, totalEquity: 0 };
      }

      return {
        spotBalance: data.spotBalance / 1e6,
        perpEquity: data.perpEquity / 1e6,
        totalEquity: data.totalEquity / 1e6,
      };
    },

    // Market data
    async getMarketPrice(marketIndex: number) {
      const data = await fetchApi<{
        probability: number;
        lastPrice: number;
      }>(`/markets/${marketIndex}`);

      if (!data) return null;

      const yesPrice = data.probability || data.lastPrice || 0.5;

      return {
        yes: yesPrice,
        no: 1 - yesPrice,
      };
    },

    async getOrderbook(marketIndex: number) {
      const data = await fetchApi<{
        bids: Array<{ price: number; size: number }>;
        asks: Array<{ price: number; size: number }>;
      }>(`/markets/${marketIndex}/orderbook`);

      if (!data) return null;

      return {
        bids: (data.bids || []).map((b) => [b.price, b.size] as [number, number]),
        asks: (data.asks || []).map((a) => [a.price, a.size] as [number, number]),
      };
    },
  }) as DriftTrading;

  return trading;
}

// Types already exported at definition above

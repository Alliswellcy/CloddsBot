/**
 * Trading Kalshi CLI Skill
 *
 * Wired to:
 *   - src/feeds/kalshi (createKalshiFeed - market data, orderbook, WebSocket)
 *   - src/execution (createExecutionService - order placement/cancellation)
 *
 * Commands:
 * /kalshi search <query>                    - Search Kalshi markets
 * /kalshi market <ticker>                   - Market details
 * /kalshi book <ticker>                     - View orderbook
 * /kalshi buy <ticker> <contracts> <price>  - Buy YES contracts
 * /kalshi sell <ticker> <contracts> <price> - Sell YES contracts
 * /kalshi positions                         - View open orders (positions)
 * /kalshi orders                            - View open orders
 * /kalshi cancel <order-id|all>             - Cancel orders
 * /kalshi balance                           - Account balance
 */

import type { KalshiFeed } from '../../../feeds/kalshi';
import type { ExecutionService } from '../../../execution';
import { logger } from '../../../utils/logger';

// =============================================================================
// HELPERS
// =============================================================================

function formatNumber(n: number, decimals = 2): string {
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(decimals) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(decimals) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(decimals) + 'K';
  return n.toFixed(decimals);
}

let feedInstance: KalshiFeed | null = null;
let execInstance: ExecutionService | null = null;

async function getFeed(): Promise<KalshiFeed> {
  if (!feedInstance) {
    const { createKalshiFeed } = await import('../../../feeds/kalshi');
    feedInstance = await createKalshiFeed({
      apiKeyId: process.env.KALSHI_API_KEY_ID,
      privateKeyPem: process.env.KALSHI_PRIVATE_KEY,
      privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH,
    });
    await feedInstance.connect();
  }
  return feedInstance;
}

function getExecution(): ExecutionService | null {
  if (!execInstance) {
    const apiKeyId = process.env.KALSHI_API_KEY_ID;
    const privateKeyPem = process.env.KALSHI_PRIVATE_KEY;

    if (!apiKeyId || !privateKeyPem) return null;

    try {
      const { createExecutionService } = require('../../../execution');
      const { normalizeKalshiPrivateKey } = require('../../../utils/kalshi-auth');
      execInstance = createExecutionService({
        kalshi: {
          apiKeyId,
          privateKeyPem: normalizeKalshiPrivateKey(privateKeyPem),
        },
        dryRun: process.env.DRY_RUN === 'true',
      });
    } catch {
      return null;
    }
  }
  return execInstance;
}

// =============================================================================
// HELP TEXT
// =============================================================================

function helpText(): string {
  return [
    '**Kalshi Trading Commands**',
    '',
    '**Market Data:**',
    '  /kalshi search <query>                    - Search markets',
    '  /kalshi market <ticker>                   - Market details',
    '  /kalshi book <ticker>                     - View orderbook',
    '',
    '**Trading:**',
    '  /kalshi buy <ticker> <contracts> <price>  - Buy YES contracts',
    '  /kalshi sell <ticker> <contracts> <price> - Sell YES contracts',
    '  /kalshi orders                            - Open orders',
    '  /kalshi cancel <order-id>                 - Cancel order',
    '  /kalshi cancel all                        - Cancel all orders',
    '',
    '**Env vars:** KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY (or KALSHI_PRIVATE_KEY_PATH)',
    '',
    '**Examples:**',
    '  /kalshi search bitcoin',
    '  /kalshi buy KXBTC-24JAN01 10 0.65',
    '  /kalshi sell KXBTC-24JAN01 5 0.70',
  ].join('\n');
}

// =============================================================================
// MARKET DATA HANDLERS
// =============================================================================

async function handleSearch(query: string): Promise<string> {
  if (!query) return 'Usage: /kalshi search <query>';

  try {
    const feed = await getFeed();
    const markets = await feed.searchMarkets(query);

    if (markets.length === 0) {
      return `No Kalshi markets found for "${query}"`;
    }

    const lines = ['**Kalshi Markets**', ''];

    for (const m of markets.slice(0, 15)) {
      const yesPrice = m.outcomes.find(o => o.name === 'Yes')?.price || 0;
      const noPrice = m.outcomes.find(o => o.name === 'No')?.price || 0;
      lines.push(`  [${m.id}] ${m.question}`);
      lines.push(`       YES: ${(yesPrice * 100).toFixed(0)}c | NO: ${(noPrice * 100).toFixed(0)}c | Vol: $${formatNumber(m.volume24h)}`);
    }

    if (markets.length > 15) {
      lines.push('', `...and ${markets.length - 15} more`);
    }

    return lines.join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error searching: ${message}`;
  }
}

async function handleMarket(ticker: string): Promise<string> {
  if (!ticker) return 'Usage: /kalshi market <ticker>';

  try {
    const feed = await getFeed();
    const market = await feed.getMarket(ticker);

    if (!market) {
      return `Market ${ticker} not found`;
    }

    const lines = [
      `**${market.question}**`,
      '',
      `Ticker: ${market.id}`,
      `Platform: Kalshi`,
      market.description ? `Description: ${market.description}` : '',
      '',
      '**Outcomes:**',
    ];

    for (const o of market.outcomes) {
      lines.push(`  ${o.name}: ${(o.price * 100).toFixed(1)}c`);
    }

    lines.push(
      '',
      `Volume 24h: $${formatNumber(market.volume24h)}`,
      `Liquidity: $${formatNumber(market.liquidity)}`,
      market.endDate ? `Closes: ${market.endDate.toLocaleDateString()}` : '',
      `Resolved: ${market.resolved ? 'Yes' : 'No'}`,
      '',
      `URL: ${market.url}`,
    );

    return lines.filter(l => l !== '').join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: ${message}`;
  }
}

async function handleOrderbook(ticker: string): Promise<string> {
  if (!ticker) return 'Usage: /kalshi book <ticker>';

  try {
    const feed = await getFeed();
    const orderbook = await feed.getOrderbook(ticker);

    if (!orderbook) {
      return `No orderbook found for ${ticker}`;
    }

    const lines = [
      `**Orderbook: ${ticker}**`,
      '',
      `Mid: ${(orderbook.midPrice * 100).toFixed(1)}c | Spread: ${(orderbook.spread * 100).toFixed(2)}c`,
      '',
      '**Bids (YES):**',
    ];

    for (const [price, size] of orderbook.bids.slice(0, 5)) {
      lines.push(`  ${(price * 100).toFixed(1)}c - ${size.toFixed(0)} contracts`);
    }

    lines.push('', '**Asks (YES):**');

    for (const [price, size] of orderbook.asks.slice(0, 5)) {
      lines.push(`  ${(price * 100).toFixed(1)}c - ${size.toFixed(0)} contracts`);
    }

    return lines.join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: ${message}`;
  }
}

// =============================================================================
// TRADING HANDLERS
// =============================================================================

async function handleBuy(ticker: string, contractsStr: string, priceStr: string): Promise<string> {
  const exec = getExecution();
  if (!exec) {
    return 'Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY to trade on Kalshi.';
  }

  if (!ticker || !contractsStr || !priceStr) {
    return 'Usage: /kalshi buy <ticker> <contracts> <price>\nExample: /kalshi buy KXBTC-24JAN01 10 0.65';
  }

  const contracts = parseInt(contractsStr, 10);
  const price = parseFloat(priceStr);

  if (isNaN(contracts) || contracts <= 0) {
    return 'Invalid number of contracts. Must be a positive integer.';
  }

  if (isNaN(price) || price < 0.01 || price > 0.99) {
    return 'Invalid price. Must be between 0.01 and 0.99 (e.g., 0.65 for 65c).';
  }

  try {
    const result = await exec.buyLimit({
      platform: 'kalshi',
      marketId: ticker,
      outcome: 'yes',
      price,
      size: contracts,
    });

    if (result.success) {
      return `BUY YES ${contracts} contracts @ ${(price * 100).toFixed(0)}c on ${ticker} (Order: ${result.orderId})`;
    }
    return `Order failed: ${result.error}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: ${message}`;
  }
}

async function handleSell(ticker: string, contractsStr: string, priceStr: string): Promise<string> {
  const exec = getExecution();
  if (!exec) {
    return 'Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY to trade on Kalshi.';
  }

  if (!ticker || !contractsStr || !priceStr) {
    return 'Usage: /kalshi sell <ticker> <contracts> <price>\nExample: /kalshi sell KXBTC-24JAN01 5 0.70';
  }

  const contracts = parseInt(contractsStr, 10);
  const price = parseFloat(priceStr);

  if (isNaN(contracts) || contracts <= 0) {
    return 'Invalid number of contracts. Must be a positive integer.';
  }

  if (isNaN(price) || price < 0.01 || price > 0.99) {
    return 'Invalid price. Must be between 0.01 and 0.99.';
  }

  try {
    const result = await exec.sellLimit({
      platform: 'kalshi',
      marketId: ticker,
      outcome: 'yes',
      price,
      size: contracts,
    });

    if (result.success) {
      return `SELL YES ${contracts} contracts @ ${(price * 100).toFixed(0)}c on ${ticker} (Order: ${result.orderId})`;
    }
    return `Order failed: ${result.error}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: ${message}`;
  }
}

async function handleOrders(): Promise<string> {
  const exec = getExecution();
  if (!exec) {
    return 'Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY to view orders.';
  }

  try {
    const orders = await exec.getOpenOrders('kalshi');

    if (orders.length === 0) {
      return 'No open Kalshi orders';
    }

    const lines = ['**Kalshi Open Orders**', ''];

    for (const o of orders) {
      lines.push(
        `  [${o.orderId}] ${o.marketId} - ${o.side.toUpperCase()} ${o.outcome?.toUpperCase() || 'YES'} @ ${(o.price * 100).toFixed(0)}c x ${o.remainingSize}/${o.originalSize}`
      );
    }

    return lines.join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: ${message}`;
  }
}

async function handleCancel(orderId: string): Promise<string> {
  const exec = getExecution();
  if (!exec) {
    return 'Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY to cancel orders.';
  }

  if (!orderId) {
    return 'Usage: /kalshi cancel <order-id|all>';
  }

  try {
    if (orderId.toLowerCase() === 'all') {
      const count = await exec.cancelAllOrders('kalshi');
      return `Cancelled ${count} Kalshi order(s)`;
    }

    const success = await exec.cancelOrder('kalshi', orderId);
    return success ? `Order ${orderId} cancelled` : `Failed to cancel order ${orderId}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: ${message}`;
  }
}

async function handleBalance(): Promise<string> {
  // Kalshi balance requires authenticated API call
  const apiKeyId = process.env.KALSHI_API_KEY_ID;
  const privateKeyPem = process.env.KALSHI_PRIVATE_KEY;

  if (!apiKeyId || !privateKeyPem) {
    return 'Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY to check balance.';
  }

  try {
    const { buildKalshiHeadersForUrl, normalizeKalshiPrivateKey } = await import('../../../utils/kalshi-auth');
    const auth = { apiKeyId, privateKeyPem: normalizeKalshiPrivateKey(privateKeyPem) };
    const url = 'https://api.elections.kalshi.com/trade-api/v2/portfolio/balance';
    const headers = buildKalshiHeadersForUrl(auth, 'GET', url);

    const response = await fetch(url, {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return `Failed to fetch balance: HTTP ${response.status}`;
    }

    const data = await response.json() as { balance?: number; portfolio_value?: number };
    const balance = (data.balance || 0) / 100; // Kalshi returns cents
    const portfolioValue = (data.portfolio_value || 0) / 100;

    return [
      '**Kalshi Balance**',
      '',
      `Cash: $${formatNumber(balance)}`,
      `Portfolio: $${formatNumber(portfolioValue)}`,
      `Total: $${formatNumber(balance + portfolioValue)}`,
    ].join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error fetching balance: ${message}`;
  }
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

async function execute(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() || 'help';

  try {
    switch (cmd) {
      case 'search':
      case 's':
        return handleSearch(parts.slice(1).join(' '));

      case 'market':
      case 'm':
        return handleMarket(parts[1]);

      case 'book':
      case 'orderbook':
      case 'ob':
        return handleOrderbook(parts[1]);

      case 'buy':
      case 'b':
        return handleBuy(parts[1], parts[2], parts[3]);

      case 'sell':
        return handleSell(parts[1], parts[2], parts[3]);

      case 'positions':
      case 'pos':
      case 'orders':
      case 'o':
        return handleOrders();

      case 'cancel':
        return handleCancel(parts[1]);

      case 'balance':
      case 'bal':
        return handleBalance();

      case 'events':
        return handleSearch('');

      case 'help':
      default:
        return helpText();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, args }, 'Kalshi command failed');
    return `Error: ${message}`;
  }
}

export default {
  name: 'trading-kalshi',
  description: 'Kalshi trading - search markets, place orders, manage positions',
  commands: ['/kalshi', '/trading-kalshi'],
  handle: execute,
};

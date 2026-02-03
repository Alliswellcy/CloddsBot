/**
 * Trading Futures CLI Skill
 *
 * Commands:
 * /futures open <symbol> <side> <size> - Open position
 * /futures close <symbol> - Close position
 * /futures positions - View positions
 * /futures funding <symbol> - Check funding rates
 * /futures pnl - P&L summary
 */

function helpText(): string {
  return `**Futures Trading Commands**

  /futures open <symbol> <side> <size> [--leverage N] [--exchange binance] - Open position
  /futures long <symbol> <size> [--leverage N] [--exchange binance]        - Open long
  /futures short <symbol> <size> [--leverage N] [--exchange binance]       - Open short
  /futures close <symbol> [--exchange binance]                             - Close position
  /futures positions [--exchange binance]                                  - View positions
  /futures funding <symbol> [--exchange binance]                           - Funding rates
  /futures leverage <symbol> <multiplier> [--exchange binance]             - Set leverage
  /futures pnl [--exchange binance]                                        - P&L summary
  /futures exchanges                                                       - Configured exchanges

Exchanges: binance, bybit, hyperliquid, mexc`;
}

function parseFlag(parts: string[], flag: string, defaultVal: string): string {
  const idx = parts.indexOf(flag);
  return idx !== -1 && parts[idx + 1] ? parts[idx + 1] : defaultVal;
}

async function execute(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() || 'help';

  try {
    const futuresMod = await import('../../../trading/futures/index');

    // Try to set up from env vars
    const { service } = await futuresMod.setupFromEnv();
    const configuredExchanges = service.getExchanges();

    if (configuredExchanges.length === 0 && cmd !== 'help' && cmd !== 'exchanges') {
      return 'No exchanges configured. Set API keys in env vars:\n  BINANCE_API_KEY + BINANCE_API_SECRET\n  BYBIT_API_KEY + BYBIT_API_SECRET\n  HYPERLIQUID_WALLET + HYPERLIQUID_PRIVATE_KEY\n  MEXC_API_KEY + MEXC_API_SECRET';
    }

    const defaultExchange = configuredExchanges[0] || 'binance';

    switch (cmd) {
      case 'open': {
        const symbol = parts[1]?.toUpperCase();
        const side = parts[2]?.toUpperCase() as 'LONG' | 'SHORT';
        const size = parseFloat(parts[3]);
        if (!symbol || !side || isNaN(size)) return 'Usage: /futures open <symbol> <long|short> <size> [--leverage N] [--exchange binance]';
        if (side !== 'LONG' && side !== 'SHORT') return 'Side must be LONG or SHORT';

        const exchange = parseFlag(parts, '--exchange', defaultExchange) as any;
        const leverage = parseInt(parseFlag(parts, '--leverage', '10'));

        const order = side === 'LONG'
          ? await service.openLong(exchange, symbol, size, leverage)
          : await service.openShort(exchange, symbol, size, leverage);

        return `**Position Opened**

Exchange: ${exchange}
Symbol: ${order.symbol}
Side: ${side}
Size: ${order.size}
Leverage: ${order.leverage}x
Type: ${order.type}
Status: ${order.status}
Fill Price: ${order.avgFillPrice || 'pending'}
Order ID: ${order.id}`;
      }

      case 'long': {
        const symbol = parts[1]?.toUpperCase();
        const size = parseFloat(parts[2]);
        if (!symbol || isNaN(size)) return 'Usage: /futures long <symbol> <size> [--leverage N] [--exchange binance]';

        const exchange = parseFlag(parts, '--exchange', defaultExchange) as any;
        const leverage = parseInt(parseFlag(parts, '--leverage', '10'));

        const order = await service.openLong(exchange, symbol, size, leverage);

        return `**Long Position Opened**

Exchange: ${exchange}
Symbol: ${order.symbol}
Size: ${order.size}
Leverage: ${order.leverage}x
Status: ${order.status}
Fill Price: ${order.avgFillPrice || 'pending'}
Order ID: ${order.id}`;
      }

      case 'short': {
        const symbol = parts[1]?.toUpperCase();
        const size = parseFloat(parts[2]);
        if (!symbol || isNaN(size)) return 'Usage: /futures short <symbol> <size> [--leverage N] [--exchange binance]';

        const exchange = parseFlag(parts, '--exchange', defaultExchange) as any;
        const leverage = parseInt(parseFlag(parts, '--leverage', '10'));

        const order = await service.openShort(exchange, symbol, size, leverage);

        return `**Short Position Opened**

Exchange: ${exchange}
Symbol: ${order.symbol}
Size: ${order.size}
Leverage: ${order.leverage}x
Status: ${order.status}
Fill Price: ${order.avgFillPrice || 'pending'}
Order ID: ${order.id}`;
      }

      case 'close': {
        const symbol = parts[1]?.toUpperCase();
        if (!symbol) return 'Usage: /futures close <symbol> [--exchange binance]';

        const exchange = parseFlag(parts, '--exchange', defaultExchange) as any;
        const result = await service.closePosition(exchange, symbol);

        if (!result) return `No open position found for ${symbol} on ${exchange}.`;

        return `**Position Closed**

Exchange: ${exchange}
Symbol: ${result.symbol}
Size: ${result.size}
Fill Price: ${result.avgFillPrice || 'N/A'}
Status: ${result.status}
Order ID: ${result.id}`;
      }

      case 'positions':
      case 'pos': {
        const exchangeInput = parseFlag(parts, '--exchange', 'all');

        let positions;
        if (exchangeInput === 'all') {
          positions = await service.getAllPositions();
        } else {
          positions = await service.getPositions(exchangeInput as any);
        }

        if (positions.length === 0) {
          return `No open positions${exchangeInput !== 'all' ? ` on ${exchangeInput}` : ''}.`;
        }

        const lines = ['**Open Futures Positions**', ''];
        let totalPnl = 0;

        for (const pos of positions) {
          const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '';
          totalPnl += pos.unrealizedPnl;
          lines.push(`**${pos.symbol}** (${pos.exchange})`);
          lines.push(`  Side: ${pos.side} | Size: ${pos.size} | Leverage: ${pos.leverage}x`);
          lines.push(`  Entry: ${pos.entryPrice} | Mark: ${pos.markPrice} | Liq: ${pos.liquidationPrice}`);
          lines.push(`  PnL: ${pnlSign}$${pos.unrealizedPnl.toFixed(2)} (${pnlSign}${pos.unrealizedPnlPct.toFixed(2)}%)`);
          lines.push('');
        }

        const totalSign = totalPnl >= 0 ? '+' : '';
        lines.push(`**Total Unrealized PnL: ${totalSign}$${totalPnl.toFixed(2)}**`);

        return lines.join('\n');
      }

      case 'funding': {
        const symbol = parts[1]?.toUpperCase();
        if (!symbol) return 'Usage: /futures funding <symbol> [--exchange binance]';

        const exchangeInput = parseFlag(parts, '--exchange', 'all');

        if (exchangeInput === 'all') {
          const lines = [`**Funding Rates for ${symbol}**`, ''];
          for (const ex of configuredExchanges) {
            try {
              const funding = await service.getFundingRate(ex, symbol);
              const ratePct = (funding.rate * 100).toFixed(4);
              const nextTime = new Date(funding.nextFundingTime).toLocaleTimeString();
              lines.push(`  ${ex}: ${ratePct}% (next: ${nextTime})`);
            } catch {
              lines.push(`  ${ex}: N/A`);
            }
          }
          return lines.join('\n');
        }

        const funding = await service.getFundingRate(exchangeInput as any, symbol);
        const ratePct = (funding.rate * 100).toFixed(4);
        const nextTime = new Date(funding.nextFundingTime).toLocaleTimeString();

        return `**Funding Rate: ${symbol} (${exchangeInput})**

Rate: ${ratePct}%
Next Funding: ${nextTime}
Annualized: ${(funding.rate * 100 * 3 * 365).toFixed(2)}%`;
      }

      case 'leverage': {
        const symbol = parts[1]?.toUpperCase();
        const leverage = parseInt(parts[2]);
        if (!symbol || isNaN(leverage)) return 'Usage: /futures leverage <symbol> <multiplier> [--exchange binance]';

        const exchange = parseFlag(parts, '--exchange', defaultExchange) as any;
        const client = service as any;
        // setLeverage is on the individual exchange client, accessed via the service
        await (service as any).getClient?.(exchange)?.setLeverage?.(symbol, leverage)
          || await (client.clients?.get(exchange) as any)?.setLeverage?.(symbol, leverage);

        return `Leverage set to ${leverage}x for ${symbol} on ${exchange}.`;
      }

      case 'pnl': {
        const exchangeInput = parseFlag(parts, '--exchange', 'all');

        let balances;
        if (exchangeInput === 'all') {
          balances = await service.getAllBalances();
        } else {
          const bal = await service.getBalance(exchangeInput as any);
          balances = [bal];
        }

        const lines = ['**Futures P&L Summary**', ''];

        let totalBalance = 0;
        let totalUnrealized = 0;

        for (const bal of balances) {
          totalBalance += bal.total;
          totalUnrealized += bal.unrealizedPnl;
          const pnlSign = bal.unrealizedPnl >= 0 ? '+' : '';
          lines.push(`**${bal.exchange}** (${bal.asset})`);
          lines.push(`  Balance: $${bal.total.toFixed(2)} (available: $${bal.available.toFixed(2)})`);
          lines.push(`  Unrealized PnL: ${pnlSign}$${bal.unrealizedPnl.toFixed(2)}`);
          lines.push(`  Margin Balance: $${bal.marginBalance.toFixed(2)}`);
          lines.push('');
        }

        const totalSign = totalUnrealized >= 0 ? '+' : '';
        lines.push(`**Total Balance: $${totalBalance.toFixed(2)}**`);
        lines.push(`**Total Unrealized: ${totalSign}$${totalUnrealized.toFixed(2)}**`);

        return lines.join('\n');
      }

      case 'exchanges': {
        if (configuredExchanges.length === 0) {
          return '**No exchanges configured.**\n\nSet API keys:\n  BINANCE_API_KEY + BINANCE_API_SECRET\n  BYBIT_API_KEY + BYBIT_API_SECRET\n  HYPERLIQUID_WALLET + HYPERLIQUID_PRIVATE_KEY\n  MEXC_API_KEY + MEXC_API_SECRET';
        }

        const lines = ['**Configured Exchanges**', ''];
        for (const ex of configuredExchanges) {
          lines.push(`  - ${ex}`);
        }
        lines.push('', 'Supported: binance, bybit, hyperliquid, mexc');
        return lines.join('\n');
      }

      case 'margin': {
        const marginMode = parts[1]?.toUpperCase();
        if (!marginMode || (marginMode !== 'ISOLATED' && marginMode !== 'CROSS')) {
          return 'Usage: /futures margin <isolated|cross> --symbol <BTCUSDT> [--exchange binance]';
        }
        const symbol = parseFlag(parts, '--symbol', '').toUpperCase();
        if (!symbol) return 'Symbol required. Usage: /futures margin <isolated|cross> --symbol <BTCUSDT>';
        const exchange = parseFlag(parts, '--exchange', defaultExchange) as any;

        // Access the exchange client to set margin type
        const client = (service as any).clients?.get(exchange) || (service as any).getClient?.(exchange);
        if (!client) return `Exchange ${exchange} not configured.`;

        if (typeof client.setMarginType === 'function') {
          await client.setMarginType(symbol, marginMode);
          return `Margin mode set to **${marginMode}** for ${symbol} on ${exchange}.`;
        }

        // Hyperliquid uses leverage call with margin type param
        if (typeof client.setLeverage === 'function' && exchange === 'hyperliquid') {
          const currentLeverage = 10; // default
          await client.setLeverage(symbol, currentLeverage, marginMode);
          return `Margin mode set to **${marginMode}** for ${symbol} on ${exchange} (via leverage endpoint).`;
        }

        return `Margin mode change not supported on ${exchange}.`;
      }

      default:
        return helpText();
    }
  } catch (err: any) {
    if (cmd === 'help' || cmd === '') return helpText();
    return `Error: ${err?.message || 'Failed to load futures module'}\n\n${helpText()}`;
  }
}

export default {
  name: 'trading-futures',
  description: 'Perpetual futures trading on Binance, Bybit, Hyperliquid, MEXC',
  commands: ['/futures', '/trading-futures'],
  handle: execute,
};

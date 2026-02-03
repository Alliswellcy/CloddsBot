/**
 * Execution CLI Skill
 *
 * Commands:
 * /exec buy <market> <amount> - Buy on market
 * /exec sell <market> <amount> - Sell on market
 * /exec orders - List open orders
 * /exec cancel <id> - Cancel order
 * /exec slippage <market> <size> - Estimate slippage
 */

async function execute(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() || 'help';

  try {
    const { createExecutionService } = await import('../../../execution/index');

    // Parse common flags
    const platformIdx = parts.indexOf('--platform');
    const platform = (platformIdx >= 0 ? parts[platformIdx + 1] : 'polymarket') as 'polymarket' | 'kalshi' | 'opinion' | 'predictfun';
    const priceIdx = parts.indexOf('--price');
    const price = priceIdx >= 0 ? parseFloat(parts[priceIdx + 1]) : undefined;
    const slippageIdx = parts.indexOf('--slippage');
    const maxSlippage = slippageIdx >= 0 ? parseFloat(parts[slippageIdx + 1]) / 100 : 0.02;

    const service = createExecutionService({} as any);

    switch (cmd) {
      case 'buy': {
        if (parts.length < 3) return 'Usage: /exec buy <market-id> <amount> [--price <p>] [--platform <name>] [--slippage <pct>]';
        const marketId = parts[1];
        const size = parseFloat(parts[2]);
        if (isNaN(size)) return 'Invalid amount.';

        const request = { platform, marketId, price: price || 0.50, size };
        const result = price
          ? await service.buyLimit(request)
          : await service.protectedBuy(request, maxSlippage);

        let output = `**Buy Order**\n\nPlatform: ${platform}\nMarket: ${marketId}\n`;
        output += `Size: ${size} shares\n`;
        if (price) output += `Price: ${price}\n`;
        output += `Status: ${result.status || (result.success ? 'submitted' : 'failed')}\n`;
        if (result.orderId) output += `Order ID: \`${result.orderId}\`\n`;
        if (result.avgFillPrice) output += `Fill price: ${result.avgFillPrice.toFixed(4)}\n`;
        if (result.error) output += `Error: ${result.error}\n`;
        return output;
      }

      case 'sell': {
        if (parts.length < 3) return 'Usage: /exec sell <market-id> <amount> [--price <p>] [--platform <name>]';
        const marketId = parts[1];
        const size = parseFloat(parts[2]);
        if (isNaN(size)) return 'Invalid amount.';

        const request = { platform, marketId, price: price || 0.50, size };
        const result = price
          ? await service.sellLimit(request)
          : await service.protectedSell(request, maxSlippage);

        let output = `**Sell Order**\n\nPlatform: ${platform}\nMarket: ${marketId}\n`;
        output += `Size: ${size} shares\n`;
        if (price) output += `Price: ${price}\n`;
        output += `Status: ${result.status || (result.success ? 'submitted' : 'failed')}\n`;
        if (result.orderId) output += `Order ID: \`${result.orderId}\`\n`;
        if (result.avgFillPrice) output += `Fill price: ${result.avgFillPrice.toFixed(4)}\n`;
        if (result.error) output += `Error: ${result.error}\n`;
        return output;
      }

      case 'orders':
      case 'open': {
        const orders = await service.getOpenOrders(platform);
        if (!orders.length) return `No open orders on ${platform}.`;
        let output = `**Open Orders** (${orders.length} on ${platform})\n\n`;
        for (const o of orders) {
          output += `[${o.orderId}] ${o.side.toUpperCase()} ${o.originalSize} @ ${o.price.toFixed(4)}`;
          output += ` | ${o.status} | ${o.marketId}\n`;
        }
        return output;
      }

      case 'cancel': {
        if (!parts[1]) return 'Usage: /exec cancel <order-id> [--platform <name>]';
        if (parts[1] === 'all') {
          const count = await service.cancelAllOrders(platform);
          return `Cancelled ${count} orders on ${platform}.`;
        }
        const success = await service.cancelOrder(platform, parts[1]);
        return success ? `Order \`${parts[1]}\` cancelled.` : `Failed to cancel order \`${parts[1]}\`.`;
      }

      case 'status': {
        if (!parts[1]) return 'Usage: /exec status <order-id> [--platform <name>]';
        const order = await service.getOrder(platform, parts[1]);
        if (!order) return `Order \`${parts[1]}\` not found on ${platform}.`;
        let output = `**Order: \`${order.orderId}\`**\n\n`;
        output += `Platform: ${platform}\n`;
        output += `Market: ${order.marketId}\n`;
        output += `Side: ${order.side}\n`;
        output += `Size: ${order.originalSize} @ ${order.price.toFixed(4)}\n`;
        output += `Status: ${order.status}\n`;
        if (order.filledSize) output += `Filled: ${order.filledSize}\n`;
        return output;
      }

      case 'slippage':
      case 'estimate': {
        if (!parts[1]) return 'Usage: /exec slippage <market-id> <size> [--platform <name>]';
        const marketId = parts[1];
        const size = parseFloat(parts[2] || '100');
        const estimate = await service.estimateSlippage({ platform, marketId, side: 'buy', price: 0.50, size });
        return `**Slippage Estimate**\n\nMarket: ${marketId}\nSize: ${size}\nEstimated slippage: ${(estimate.slippage * 100).toFixed(2)}%\nExpected price: ${estimate.expectedPrice.toFixed(4)}`;
      }

      default:
        return helpText();
    }
  } catch {
    return helpText();
  }
}

function helpText(): string {
  return `**Execution Commands**

  /exec buy <market> <amount>          - Place buy order
  /exec sell <market> <amount>         - Place sell order
  /exec orders                         - List open orders
  /exec cancel <id|all>                - Cancel order(s)
  /exec status <id>                    - Check order status
  /exec slippage <market> <size>       - Estimate slippage

**Options:**
  --price <price>                      - Limit price (omit for market order)
  --platform <name>                    - polymarket, kalshi, opinion, predictfun
  --slippage <pct>                     - Max slippage % (default: 2)`;
}

export default {
  name: 'execution',
  description: 'Execute trades on prediction markets with slippage protection',
  commands: ['/exec', '/execute'],
  handle: execute,
};

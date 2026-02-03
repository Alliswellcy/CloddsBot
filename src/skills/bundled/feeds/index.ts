/**
 * Feeds CLI Skill
 *
 * Commands:
 * /feeds status - Show feed connection status and cache stats
 * /feeds list - List available feeds
 * /feeds subscribe <platform> <market> - Subscribe to price updates
 * /feeds unsubscribe <platform> <market> - Unsubscribe from updates
 */

// Track active subscriptions so unsubscribe actually works
const activeSubscriptions = new Map<string, () => void>();

async function execute(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() || 'status';

  try {
    const feedsMod = await import('../../../feeds/index');
    const configMod = await import('../../../config/index');
    let config;
    try {
      config = configMod.loadConfig();
    } catch {
      config = configMod.DEFAULT_CONFIG;
    }
    const feedManager = await feedsMod.createFeedManager(config.feeds ?? {} as any);

    switch (cmd) {
      case 'status': {
        const cacheStats = feedManager.getCacheStats();
        let output = '**Feed Status**\n\n';
        output += `Cache size: ${cacheStats.size} entries\n`;
        output += `Cache hit rate: ${(cacheStats.hitRate * 100).toFixed(1)}%\n`;
        output += `Cache hits: ${cacheStats.hits} / misses: ${cacheStats.misses}\n`;
        return output;
      }

      case 'list':
      case 'ls': {
        const platforms = [
          'polymarket', 'kalshi', 'manifold', 'metaculus', 'predictit',
          'drift', 'betfair', 'smarkets', 'opinion', 'virtuals',
          'predictfun', 'hedgehog',
        ];
        let output = '**Available Feeds**\n\n';
        output += '| Platform | Description |\n|----------|-------------|\n';
        for (const p of platforms) {
          output += `| ${p} | ${p.charAt(0).toUpperCase() + p.slice(1)} market feed |\n`;
        }
        output += '\nUse `/feeds subscribe <platform> <market-id>` to subscribe.';
        return output;
      }

      case 'subscribe':
      case 'sub': {
        if (parts.length < 3) return 'Usage: /feeds subscribe <platform> <market-id>';
        const platform = parts[1].toLowerCase();
        const marketId = parts[2];

        // Attempt to fetch the market to validate it exists
        const market = await feedManager.getMarket(marketId, platform);
        if (!market) {
          return `Market \`${marketId}\` not found on **${platform}**. Check the ID and try again.`;
        }

        // Subscribe to price updates and store the unsubscribe handle
        const subKey = `${platform}:${marketId}`;
        const unsub = feedManager.subscribePrice(platform, marketId, (update) => {
          // Subscription callback - updates are emitted on the feed manager
        });
        activeSubscriptions.set(subKey, unsub);

        const question = market.question ?? market.id;
        const price = market.outcomes?.[0]?.price;
        let output = `Subscribed to **${platform}** market \`${marketId}\`\n\n`;
        output += `**${question}**\n`;
        if (price != null) {
          output += `Current price: $${price.toFixed(3)}\n`;
        }
        return output;
      }

      case 'unsubscribe':
      case 'unsub': {
        if (parts.length < 3) return 'Usage: /feeds unsubscribe <platform> <market-id>';
        const platform = parts[1].toLowerCase();
        const marketId = parts[2];
        const subKey = `${platform}:${marketId}`;
        const unsub = activeSubscriptions.get(subKey);
        if (!unsub) {
          return `No active subscription for **${platform}** market \`${marketId}\`.`;
        }
        unsub();
        activeSubscriptions.delete(subKey);
        return `Unsubscribed from **${platform}** market \`${marketId}\`.`;
      }

      case 'search': {
        if (parts.length < 2) return 'Usage: /feeds search <query> [platform]';
        const query = parts.slice(1, parts.length > 2 ? -1 : undefined).join(' ');
        const platform = parts.length > 2 ? parts[parts.length - 1].toLowerCase() : undefined;

        const markets = await feedManager.searchMarkets(query, platform);
        if (!markets.length) return `No markets found for "${query}".`;

        let output = `**Search Results** (${markets.length})\n\n`;
        for (const m of markets.slice(0, 10)) {
          const price = m.outcomes?.[0]?.price;
          output += `[${m.platform}] **${m.question ?? m.id}**\n`;
          if (price != null) output += `  Price: $${price.toFixed(3)}`;
          if (m.volume24h) output += ` | Vol: $${m.volume24h.toLocaleString()}`;
          output += `\n  ID: \`${m.id}\`\n\n`;
        }
        return output;
      }

      case 'price': {
        if (parts.length < 3) return 'Usage: /feeds price <platform> <market-id>';
        const platform = parts[1].toLowerCase();
        const marketId = parts[2];

        const price = await feedManager.getPrice(platform, marketId);
        if (price == null) return `Could not fetch price for \`${marketId}\` on **${platform}**.`;
        return `**${platform}** \`${marketId}\`: $${price.toFixed(4)}`;
      }

      case 'cache': {
        if (parts[1]?.toLowerCase() === 'clear') {
          feedManager.clearCache();
          return 'Market cache cleared.';
        }
        const stats = feedManager.getCacheStats();
        return `**Cache Stats**\n\nSize: ${stats.size}\nHits: ${stats.hits}\nMisses: ${stats.misses}\nHit Rate: ${(stats.hitRate * 100).toFixed(1)}%`;
      }

      default:
        return helpText();
    }
  } catch {
    return helpText();
  }
}

function helpText(): string {
  return `**Feeds Commands**

  /feeds status                      - Connection status and cache stats
  /feeds list                        - Available feeds
  /feeds subscribe <platform> <id>   - Subscribe to market price updates
  /feeds unsubscribe <platform> <id> - Unsubscribe from updates
  /feeds search <query> [platform]   - Search for markets
  /feeds price <platform> <id>       - Get current price
  /feeds cache [clear]               - View or clear cache`;
}

export default {
  name: 'feeds',
  description: 'Real-time market data feeds from prediction market platforms',
  commands: ['/feeds', '/feed'],
  handle: execute,
};

/**
 * Portfolio CLI Skill
 *
 * Commands:
 * /portfolio - Show portfolio summary
 * /portfolio positions - Active positions
 * /portfolio pnl - P&L breakdown
 * /portfolio sync - Sync from exchanges
 * /portfolio risk - Risk metrics (concentration, correlation)
 * /portfolio exposure - Category exposure breakdown
 */

async function execute(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() || 'summary';

  try {
    const mod = await import('../../../portfolio/index');
    const { createPortfolioService } = mod;

    // Build config from environment variables
    const config: Record<string, unknown> = {};
    if (process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_API_PASSPHRASE) {
      config.polymarket = {
        key: process.env.POLY_API_KEY,
        secret: process.env.POLY_API_SECRET,
        passphrase: process.env.POLY_API_PASSPHRASE,
      };
    }
    if (process.env.KALSHI_API_KEY && process.env.KALSHI_PRIVATE_KEY) {
      config.kalshi = {
        apiKey: process.env.KALSHI_API_KEY,
        privateKey: process.env.KALSHI_PRIVATE_KEY,
      };
    }

    const hasAnyPlatform = config.polymarket || config.kalshi;
    if (!hasAnyPlatform && cmd !== 'help') {
      return '**Portfolio**\n\nNo platform credentials configured.\n\n' +
        'Set environment variables to connect:\n' +
        '- Polymarket: `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_API_PASSPHRASE`\n' +
        '- Kalshi: `KALSHI_API_KEY`, `KALSHI_PRIVATE_KEY`\n\n' +
        'Or use `/creds set <platform> <key> <value>` to store credentials.';
    }

    const service = createPortfolioService(config as any);

    switch (cmd) {
      case 'summary':
      case '': {
        const text = await service.formatSummary();
        return text;
      }

      case 'positions':
      case 'pos': {
        const text = await service.formatPositionsTable();
        return text;
      }

      case 'pnl': {
        const summary = await service.getSummary();
        const pnlSign = (v: number) => v >= 0 ? '+' : '';

        let output = '**P&L Breakdown**\n\n';
        output += `Unrealized P&L: ${pnlSign(summary.unrealizedPnL)}$${summary.unrealizedPnL.toFixed(2)} (${pnlSign(summary.unrealizedPnLPct)}${summary.unrealizedPnLPct.toFixed(1)}%)\n`;
        output += `Realized P&L: ${pnlSign(summary.realizedPnL)}$${summary.realizedPnL.toFixed(2)}\n`;
        output += `Total Cost Basis: $${summary.totalCostBasis.toFixed(2)}\n`;
        output += `Current Value: $${summary.totalValue.toFixed(2)}\n\n`;

        if (summary.positions.length > 0) {
          output += '**By Position:**\n\n';
          const sorted = [...summary.positions].sort((a, b) => b.unrealizedPnL - a.unrealizedPnL);
          for (const pos of sorted) {
            const label = pos.marketQuestion
              ? pos.marketQuestion.slice(0, 35) + (pos.marketQuestion.length > 35 ? '...' : '')
              : pos.marketId.slice(0, 20);
            output += `  ${pnlSign(pos.unrealizedPnL)}$${pos.unrealizedPnL.toFixed(2)} | ${label} (${pos.outcome})\n`;
          }
        }

        return output;
      }

      case 'sync':
      case 'refresh': {
        await service.refresh();
        const summary = await service.getSummary();
        return `**Portfolio Synced**\n\n` +
          `Positions: ${summary.positionsCount}\n` +
          `Total Value: $${summary.totalValue.toFixed(2)}\n` +
          `Balances: ${summary.balances.map(b => `${b.platform}: $${b.available.toFixed(2)}`).join(', ')}\n` +
          `Updated: ${summary.lastUpdated.toLocaleTimeString()}`;
      }

      case 'risk': {
        const risk = await service.getPortfolioRiskMetrics();
        const conc = risk.concentrationRisk;

        let output = '**Portfolio Risk**\n\n';
        output += `Risk Level: **${conc.riskLevel.toUpperCase()}**\n`;
        output += `Concentration (HHI): ${conc.hhi}\n`;
        output += `Largest Position: ${conc.largestPositionPct.toFixed(1)}%\n`;
        output += `Top 3 Positions: ${conc.top3Pct.toFixed(1)}%\n`;
        output += `Diversification Score: ${conc.diversificationScore}/100\n`;
        output += `Portfolio Correlation: ${risk.correlationMatrix.portfolioCorrelation.toFixed(2)}\n\n`;

        if (risk.correlationMatrix.highCorrelationPairs.length > 0) {
          output += '**High Correlations:**\n';
          for (const pair of risk.correlationMatrix.highCorrelationPairs) {
            output += `  ${pair.positionA.slice(0, 15)} <-> ${pair.positionB.slice(0, 15)}: ${pair.correlation.toFixed(2)} (${pair.reason})\n`;
          }
          output += '\n';
        }

        if (risk.hedgedPositions.length > 0) {
          output += '**Hedged Pairs:**\n';
          for (const hedge of risk.hedgedPositions) {
            output += `  ${hedge.longPosition.slice(0, 15)} / ${hedge.shortPosition.slice(0, 15)} (ratio: ${hedge.hedgeRatio.toFixed(2)})\n`;
          }
          output += '\n';
        }

        output += '**Platform Exposure:**\n';
        for (const p of risk.platformExposure) {
          output += `  ${p.platform}: ${p.positionCount} positions, $${p.totalValue.toFixed(2)} (${p.valuePercent.toFixed(1)}%)\n`;
        }

        return output;
      }

      case 'exposure': {
        const exposure = await service.getCategoryExposure();
        if (exposure.length === 0) {
          return '**Category Exposure**\n\nNo positions to analyze.';
        }

        let output = '**Category Exposure**\n\n';
        output += '| Category | Positions | Value | % |\n|----------|-----------|-------|---|\n';
        for (const cat of exposure) {
          output += `| ${cat.category} | ${cat.positionCount} | $${cat.totalValue.toFixed(2)} | ${cat.valuePercent.toFixed(1)}% |\n`;
        }
        return output;
      }

      case 'value': {
        const totalValue = await service.getTotalValue();
        return `**Total Portfolio Value:** $${totalValue.toFixed(2)}`;
      }

      case 'platform': {
        const platform = parts[1]?.toLowerCase();
        if (!platform || (platform !== 'polymarket' && platform !== 'kalshi')) {
          return 'Usage: /portfolio platform <polymarket|kalshi>';
        }
        const positions = await service.getPositionsByPlatform(platform);
        if (positions.length === 0) {
          return `**${platform} Positions**\n\nNo positions on ${platform}.`;
        }
        let output = `**${platform} Positions** (${positions.length})\n\n`;
        for (const pos of positions) {
          const label = pos.marketQuestion
            ? pos.marketQuestion.slice(0, 40) + (pos.marketQuestion.length > 40 ? '...' : '')
            : pos.marketId.slice(0, 20);
          const pnlSign = pos.unrealizedPnL >= 0 ? '+' : '';
          output += `**${label}**\n`;
          output += `  ${pos.outcome}: ${pos.shares.toFixed(2)} @ $${pos.currentPrice.toFixed(3)}\n`;
          output += `  ${pnlSign}$${pos.unrealizedPnL.toFixed(2)} (${pnlSign}${pos.unrealizedPnLPct.toFixed(1)}%)\n\n`;
        }
        return output;
      }

      default:
        return helpText();
    }
  } catch {
    return helpText();
  }
}

function helpText(): string {
  return `**Portfolio Commands**

  /portfolio                         - Summary
  /portfolio positions               - Active positions
  /portfolio pnl                     - P&L breakdown
  /portfolio sync                    - Sync from exchanges
  /portfolio risk                    - Risk metrics
  /portfolio exposure                - Category exposure
  /portfolio value                   - Total portfolio value
  /portfolio platform <name>         - Positions by platform`;
}

export default {
  name: 'portfolio',
  description: 'Track your positions and P&L across prediction market platforms',
  commands: ['/portfolio', '/pf', '/positions'],
  handle: execute,
};

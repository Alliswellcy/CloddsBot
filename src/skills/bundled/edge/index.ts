/**
 * Edge CLI Skill
 *
 * Commands:
 * /edge scan - Scan for weather market edges
 * /edge calc <market-id> - Calculate edge for specific market
 * /edge top - Top edge opportunities
 */

async function execute(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() || 'help';

  try {
    const { getWeatherEdgeCalculator } = await import('../../../weather/edge');
    const calculator = getWeatherEdgeCalculator();

    switch (cmd) {
      case 'scan':
      case 'top': {
        const result = await calculator.scanForEdge();
        if (!result.topOpportunities.length) return 'No edge opportunities found right now.';
        let output = `**Edge Scan** (${result.marketsWithEdge}/${result.totalMarkets} with edge)\n\n`;
        for (const opp of result.topOpportunities.slice(0, 10)) {
          output += `${opp.recommendation} ${opp.market.question.slice(0, 50)}\n`;
          output += `  Edge: ${opp.edgePercent.toFixed(2)}% | Market: ${(opp.marketPrice * 100).toFixed(0)}c | NOAA: ${opp.noaaProbability.toFixed(0)}%\n`;
          output += `  Confidence: ${opp.confidence}\n\n`;
        }
        return output;
      }

      case 'calc': {
        if (!parts[1]) return 'Usage: /edge calc <market-id>';
        // calculateEdge takes a WeatherMarket object, so we show the market ID note
        return `Edge calculation requires a full market object.\nUse \`/edge scan\` to see all edges, or use the API: \`calculator.calculateEdge(market)\``;
      }

      default:
        return helpText();
    }
  } catch {
    return helpText();
  }
}

function helpText(): string {
  return `**Edge Commands**

  /edge scan                         - Scan for weather market edges
  /edge top                          - Top edge opportunities
  /edge calc <market-id>             - Calculate edge for specific market`;
}

export default {
  name: 'edge',
  description: 'Edge calculation for weather and prediction markets using NOAA data',
  commands: ['/edge'],
  handle: execute,
};

/**
 * Risk CLI Skill
 *
 * Commands:
 * /risk - Current risk status
 * /risk status - Detailed status
 * /risk limits - View all limits
 * /risk set <param> <value> - Configure a limit
 * /risk trip "reason" - Manually trip circuit breaker
 * /risk reset - Reset after cooldown
 * /risk kill - Emergency stop all trading
 * /risk check <notional> - Check if a trade is allowed
 */

import { enforceMaxOrderSize, enforceExposureLimits, type RiskContext } from '../../../trading/risk';

// In-memory risk state (no persistent DB dependency required)
let circuitBreakerState: 'armed' | 'tripped' | 'killed' = 'armed';
let tripReason: string | null = null;
let tripTime: number | null = null;

const limits: Record<string, number> = {
  'max-loss': 1000,
  'max-loss-pct': 10,
  'max-drawdown': 20,
  'max-position': 25,
  'max-trades': 50,
  'consecutive-losses': 5,
};

function handleStatus(): string {
  let output = '**Risk Status**\n\n';
  output += `Circuit Breaker: ${circuitBreakerState}\n`;
  output += `Trading Allowed: ${circuitBreakerState === 'armed' ? 'Yes' : 'No'}\n`;
  if (tripReason) {
    output += `Trip Reason: ${tripReason}\n`;
  }
  if (tripTime) {
    output += `Tripped At: ${new Date(tripTime).toLocaleString()}\n`;
  }
  output += '\n**Limits:**\n';
  for (const [key, value] of Object.entries(limits)) {
    output += `  ${key}: ${value}\n`;
  }
  return output;
}

function handleLimits(): string {
  let output = '**Risk Limits**\n\n';
  output += `| Parameter | Value |\n`;
  output += `|-----------|-------|\n`;
  for (const [key, value] of Object.entries(limits)) {
    output += `| ${key} | ${value} |\n`;
  }
  return output;
}

function handleSet(param: string, value: string): string {
  const numValue = parseFloat(value);
  if (isNaN(numValue)) {
    return `Invalid value: ${value}. Must be a number.`;
  }

  const validParams = Object.keys(limits);
  if (!validParams.includes(param)) {
    return `Unknown parameter: ${param}\n\nValid parameters: ${validParams.join(', ')}`;
  }

  limits[param] = numValue;
  return `Set **${param}** to **${numValue}**`;
}

function handleTrip(reason: string): string {
  if (circuitBreakerState === 'killed') {
    return 'System is in KILLED state. Use `/risk reset` first.';
  }
  circuitBreakerState = 'tripped';
  tripReason = reason || 'Manual trip';
  tripTime = Date.now();
  return `Circuit breaker **TRIPPED**: ${tripReason}`;
}

function handleReset(): string {
  if (circuitBreakerState === 'armed') {
    return 'Circuit breaker is already armed. No reset needed.';
  }
  circuitBreakerState = 'armed';
  tripReason = null;
  tripTime = null;
  return 'Circuit breaker **RESET**. Trading is now allowed.';
}

function handleKill(): string {
  circuitBreakerState = 'killed';
  tripReason = 'Emergency kill switch activated';
  tripTime = Date.now();
  return '**EMERGENCY STOP** - All trading disabled. Manual reset required via `/risk reset`.';
}

function handleCheck(notionalStr: string): string {
  const notional = parseFloat(notionalStr);
  if (isNaN(notional) || notional <= 0) {
    return 'Usage: /risk check <notional>\n\nExample: /risk check 500';
  }

  if (circuitBreakerState !== 'armed') {
    return `Trade **BLOCKED** - Circuit breaker is ${circuitBreakerState}.\nReason: ${tripReason || 'N/A'}`;
  }

  const maxOrderSize = limits['max-loss'] || 1000;
  const result = enforceMaxOrderSize(
    { tradingContext: { maxOrderSize }, db: { getUser: () => undefined, getPositions: () => [] } },
    notional,
    `Risk check for $${notional}`
  );

  if (result) {
    return `Trade **BLOCKED**:\n\`\`\`json\n${result}\n\`\`\``;
  }

  return `Trade **ALLOWED** - $${notional} is within risk limits.`;
}

export async function execute(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase() || 'status';
  const rest = parts.slice(1);

  switch (command) {
    case 'status':
      return handleStatus();

    case 'limits':
      return handleLimits();

    case 'set':
      if (rest.length < 2) return 'Usage: /risk set <param> <value>\n\nExample: /risk set max-loss 2000';
      return handleSet(rest[0], rest[1]);

    case 'trip':
      return handleTrip(rest.join(' '));

    case 'reset':
      return handleReset();

    case 'kill':
      return handleKill();

    case 'check':
      if (!rest[0]) return 'Usage: /risk check <notional>\n\nExample: /risk check 500';
      return handleCheck(rest[0]);

    case 'help':
    default:
      return `**Risk Management Commands**

**Status:**
  /risk                         Current risk status
  /risk status                  Detailed status
  /risk limits                  View all limits

**Configure:**
  /risk set max-loss 1000       Max daily loss ($)
  /risk set max-loss-pct 10     Max daily loss (%)
  /risk set max-drawdown 20     Max drawdown (%)
  /risk set max-position 25     Max single position (%)
  /risk set max-trades 50       Max trades per day
  /risk set consecutive-losses 5  Stop after N losses

**Circuit Breaker:**
  /risk trip "reason"           Manually trip breaker
  /risk reset                   Reset after cooldown
  /risk kill                    Emergency stop all trading

**Checks:**
  /risk check 500               Check if trade is allowed`;
  }
}

export default {
  name: 'risk',
  description: 'Circuit breaker, loss limits, and automated risk controls',
  commands: ['/risk'],
  handle: execute,
};

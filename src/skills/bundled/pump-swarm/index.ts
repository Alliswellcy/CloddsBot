/**
 * Pump.fun Swarm Trading Skill
 *
 * Coordinate multiple wallets for synchronized Pump.fun trading.
 */

import {
  PumpFunSwarm,
  getSwarm,
  SwarmTradeParams,
  SwarmTradeResult,
  SwarmWallet,
} from '../../../solana/pump-swarm';

// ============================================================================
// Helpers
// ============================================================================

function formatSol(sol: number): string {
  return sol.toFixed(4);
}

function formatTokens(amount: number): string {
  if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(2)}B`;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(2)}K`;
  return amount.toFixed(0);
}

function parseWalletIds(arg: string): string[] {
  return arg.split(',').map(s => s.trim()).filter(Boolean);
}

function formatTradeResult(result: SwarmTradeResult): string {
  const successCount = result.walletResults.filter(r => r.success).length;
  const totalCount = result.walletResults.length;

  let output = `**Swarm ${result.action.toUpperCase()} Result**\n\n`;
  output += `Token: \`${result.mint.slice(0, 20)}...\`\n`;
  output += `Status: ${result.success ? '✅ Success' : '❌ Failed'} (${successCount}/${totalCount} wallets)\n`;

  if (result.totalSolSpent) {
    output += `Total SOL: ${formatSol(result.totalSolSpent)}\n`;
  }
  output += `Time: ${result.executionTimeMs}ms\n`;

  if (result.bundleId) {
    output += `Bundle: \`${result.bundleId.slice(0, 20)}...\`\n`;
  }

  if (result.errors && result.errors.length > 0) {
    output += `\n**Errors:**\n`;
    for (const err of result.errors.slice(0, 5)) {
      output += `  - ${err}\n`;
    }
    if (result.errors.length > 5) {
      output += `  ... and ${result.errors.length - 5} more\n`;
    }
  }

  output += '\n**Wallet Results:**\n';
  for (const wr of result.walletResults) {
    const status = wr.success ? '✅' : '❌';
    output += `${status} **${wr.walletId}** (\`${wr.publicKey.slice(0, 8)}...\`)`;
    if (wr.success && wr.signature) {
      output += ` [tx](https://solscan.io/tx/${wr.signature})`;
    }
    if (wr.error) {
      output += ` - ${wr.error.slice(0, 50)}`;
    }
    output += '\n';
  }

  return output;
}

// ============================================================================
// Command Handlers
// ============================================================================

async function handleWallets(): Promise<string> {
  const swarm = getSwarm();
  const wallets = swarm.getWallets();

  if (wallets.length === 0) {
    return `**No Swarm Wallets Configured**

Set up wallets with environment variables:
\`\`\`bash
export SOLANA_PRIVATE_KEY="main-wallet-key"
export SOLANA_SWARM_KEY_1="wallet-2-key"
export SOLANA_SWARM_KEY_2="wallet-3-key"
# ... up to SOLANA_SWARM_KEY_20
\`\`\``;
  }

  const counts = swarm.getWalletCount();
  let output = `**Swarm Wallets (${counts.enabled}/${counts.total} enabled)**\n\n`;

  for (const w of wallets) {
    const status = w.enabled ? '🟢' : '🔴';
    output += `${status} **${w.id}**\n`;
    output += `   \`${w.publicKey}\`\n`;
    output += `   SOL: ${formatSol(w.solBalance)}`;
    if (w.positions.size > 0) {
      output += ` | ${w.positions.size} positions`;
    }
    output += '\n\n';
  }

  output += `_Run \`/swarm balances\` to refresh SOL balances_`;
  return output;
}

async function handleBalances(): Promise<string> {
  const swarm = getSwarm();
  const wallets = swarm.getWallets();

  if (wallets.length === 0) {
    return 'No swarm wallets configured. Set SOLANA_PRIVATE_KEY and SOLANA_SWARM_KEY_N env vars.';
  }

  let output = '**Fetching balances from chain...**\n\n';
  const balances = await swarm.refreshBalances();

  let totalSol = 0;
  for (const [id, balance] of balances) {
    const wallet = swarm.getWallet(id);
    const status = wallet?.enabled ? '🟢' : '🔴';
    output += `${status} ${id}: **${formatSol(balance)} SOL**\n`;
    totalSol += balance;
  }

  output += `\n**Total: ${formatSol(totalSol)} SOL** across ${balances.size} wallets`;
  return output;
}

async function handleRefresh(mint: string): Promise<string> {
  if (!mint) return 'Usage: /swarm refresh <mint>\n\nRefreshes token positions from chain for all wallets.';

  const swarm = getSwarm();

  let output = `**Refreshing positions for \`${mint.slice(0, 20)}...\`**\n\n`;
  const position = await swarm.refreshTokenPositions(mint);

  if (position.totalTokens === 0) {
    return output + 'No positions found across any wallets.';
  }

  output += `**Total: ${formatTokens(position.totalTokens)} tokens**\n\n`;
  output += `**By Wallet:**\n`;

  for (const [walletId, amount] of position.byWallet) {
    const pct = (amount / position.totalTokens * 100).toFixed(1);
    output += `  ${walletId}: ${formatTokens(amount)} (${pct}%)\n`;
  }

  return output;
}

async function handleEnable(walletId: string): Promise<string> {
  if (!walletId) return 'Usage: /swarm enable <wallet_id>';

  const swarm = getSwarm();
  const wallet = swarm.getWallet(walletId);

  if (!wallet) {
    const wallets = swarm.getWallets();
    return `Wallet "${walletId}" not found.\n\nAvailable: ${wallets.map(w => w.id).join(', ')}`;
  }

  swarm.enableWallet(walletId);
  return `✅ Wallet **${walletId}** enabled for trading.`;
}

async function handleDisable(walletId: string): Promise<string> {
  if (!walletId) return 'Usage: /swarm disable <wallet_id>';

  const swarm = getSwarm();
  const wallet = swarm.getWallet(walletId);

  if (!wallet) {
    return `Wallet "${walletId}" not found.`;
  }

  swarm.disableWallet(walletId);
  return `🔴 Wallet **${walletId}** disabled. Will not participate in trades.`;
}

async function handleBuy(args: string[]): Promise<string> {
  if (args.length < 2) {
    return `**Usage:** /swarm buy <mint> <sol_per_wallet> [options]

**Options:**
  --wallets <id1,id2,...>  Use specific wallets only
  --bundle                 Force Jito bundle (atomic)
  --sequential             Force sequential execution
  --slippage <bps>         Slippage tolerance (default: 500 = 5%)
  --pool <pool>            Pool: pump, raydium, auto

**Examples:**
  /swarm buy ABC123... 0.1
  /swarm buy ABC123... 0.05 --wallets wallet_0,wallet_1
  /swarm buy ABC123... 0.1 --bundle --slippage 1000`;
  }

  const mint = args[0];
  const amountPerWallet = parseFloat(args[1]);

  if (isNaN(amountPerWallet) || amountPerWallet <= 0) {
    return '❌ Invalid amount. Must be a positive number (SOL per wallet).';
  }

  if (amountPerWallet > 10) {
    return '❌ Amount too high. Max 10 SOL per wallet for safety.';
  }

  // Parse options
  let walletIds: string[] | undefined;
  let useBundle: boolean | undefined;
  let slippageBps: number | undefined;
  let pool: string | undefined;

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--wallets' && args[i + 1]) {
      walletIds = parseWalletIds(args[++i]);
    } else if (args[i] === '--bundle') {
      useBundle = true;
    } else if (args[i] === '--sequential') {
      useBundle = false;
    } else if (args[i] === '--slippage' && args[i + 1]) {
      slippageBps = parseInt(args[++i]);
    } else if (args[i] === '--pool' && args[i + 1]) {
      pool = args[++i];
    }
  }

  const swarm = getSwarm();
  const counts = swarm.getWalletCount();

  if (counts.enabled === 0) {
    return '❌ No enabled wallets. Run `/swarm wallets` to check status.';
  }

  const totalSol = amountPerWallet * (walletIds?.length || counts.enabled);
  let output = `**Swarm Buy**\n\n`;
  output += `Token: \`${mint}\`\n`;
  output += `Amount: **${formatSol(amountPerWallet)} SOL** per wallet\n`;
  output += `Wallets: ${walletIds?.length || counts.enabled}\n`;
  output += `Max Total: ~${formatSol(totalSol)} SOL\n`;
  output += `Mode: ${useBundle === false ? 'Sequential (staggered)' : 'Jito Bundle (atomic)'}\n\n`;
  output += `_Executing..._\n\n`;

  const result = await swarm.coordinatedBuy({
    mint,
    action: 'buy',
    amountPerWallet,
    denominatedInSol: true,
    slippageBps,
    pool,
    useBundle,
    walletIds,
  });

  return output + formatTradeResult(result);
}

async function handleSell(args: string[]): Promise<string> {
  if (args.length < 2) {
    return `**Usage:** /swarm sell <mint> <amount|%> [options]

**Amount formats:**
  - Percentage: "100%" or "50%" (of each wallet's position)
  - Tokens: exact token amount per wallet

**Options:**
  --wallets <id1,id2,...>  Use specific wallets only
  --bundle                 Force Jito bundle (atomic)
  --sequential             Force sequential execution
  --slippage <bps>         Slippage tolerance (default: 500 = 5%)
  --pool <pool>            Pool: pump, raydium, auto

**Examples:**
  /swarm sell ABC123... 100%
  /swarm sell ABC123... 50% --bundle
  /swarm sell ABC123... 1000000 --sequential`;
  }

  const mint = args[0];
  const amountArg = args[1];

  // Parse options
  let walletIds: string[] | undefined;
  let useBundle: boolean | undefined;
  let slippageBps: number | undefined;
  let pool: string | undefined;

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--wallets' && args[i + 1]) {
      walletIds = parseWalletIds(args[++i]);
    } else if (args[i] === '--bundle') {
      useBundle = true;
    } else if (args[i] === '--sequential') {
      useBundle = false;
    } else if (args[i] === '--slippage' && args[i + 1]) {
      slippageBps = parseInt(args[++i]);
    } else if (args[i] === '--pool' && args[i + 1]) {
      pool = args[++i];
    }
  }

  const swarm = getSwarm();

  let output = `**Swarm Sell**\n\n`;
  output += `Token: \`${mint}\`\n`;
  output += `Amount: **${amountArg}** per wallet\n`;
  output += `Mode: ${useBundle === false ? 'Sequential (staggered)' : 'Jito Bundle (atomic)'}\n\n`;
  output += `_Fetching positions and executing..._\n\n`;

  const result = await swarm.coordinatedSell({
    mint,
    action: 'sell',
    amountPerWallet: amountArg,
    denominatedInSol: false,
    slippageBps,
    pool,
    useBundle,
    walletIds,
  });

  return output + formatTradeResult(result);
}

async function handlePosition(mint: string): Promise<string> {
  if (!mint) {
    return `**Usage:** /swarm position <mint>

Shows cached token positions. Use \`/swarm refresh <mint>\` to fetch fresh data from chain.`;
  }

  const swarm = getSwarm();
  const position = swarm.getSwarmPosition(mint);

  if (position.totalTokens === 0) {
    return `No cached position for \`${mint.slice(0, 30)}...\`

Run \`/swarm refresh ${mint}\` to fetch from chain.`;
  }

  let output = `**Swarm Position**\n\n`;
  output += `Token: \`${mint}\`\n`;
  output += `Total: **${formatTokens(position.totalTokens)}** tokens\n\n`;
  output += `**By Wallet:**\n`;

  for (const [walletId, amount] of position.byWallet) {
    const pct = (amount / position.totalTokens * 100).toFixed(1);
    output += `  ${walletId}: ${formatTokens(amount)} (${pct}%)\n`;
  }

  output += `\n_Last updated: ${new Date(position.lastUpdated).toLocaleTimeString()}_`;
  return output;
}

async function handleHelp(): Promise<string> {
  return `**Pump.fun Swarm Trading**

Coordinate multiple wallets for synchronized trading.

**Wallet Management:**
  /swarm wallets              List all swarm wallets
  /swarm balances             Refresh SOL balances from chain
  /swarm enable <id>          Enable wallet for trading
  /swarm disable <id>         Disable wallet

**Trading:**
  /swarm buy <mint> <sol>     Buy on all enabled wallets
  /swarm sell <mint> <amt|%>  Sell from all wallets with positions
  /swarm position <mint>      Check cached positions
  /swarm refresh <mint>       Fetch fresh positions from chain

**Common Options:**
  --wallets <id1,id2>   Trade with specific wallets only
  --bundle              Force Jito bundle (atomic, all-or-nothing)
  --sequential          Force sequential (staggered timing)
  --slippage <bps>      Slippage in basis points (500 = 5%)
  --pool <pool>         Pool: pump, raydium, auto

**Setup (env vars):**
  SOLANA_PRIVATE_KEY     Main wallet (wallet_0)
  SOLANA_SWARM_KEY_1     Swarm wallet 1
  SOLANA_SWARM_KEY_2     Swarm wallet 2
  ...                    Up to SOLANA_SWARM_KEY_20
  SOLANA_RPC_URL         Custom RPC (optional)
  PUMPPORTAL_API_KEY     PumpPortal API key (optional)

**Examples:**
  /swarm buy ABC... 0.1                    # 0.1 SOL per wallet
  /swarm sell ABC... 100% --bundle         # Sell all atomically
  /swarm buy ABC... 0.05 --wallets wallet_0,wallet_1`;
}

// ============================================================================
// Main Execute Function
// ============================================================================

export async function execute(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase() || 'help';
  const rest = parts.slice(1);

  try {
    switch (command) {
      case 'wallets':
      case 'list':
        return await handleWallets();
      case 'balances':
      case 'balance':
        return await handleBalances();
      case 'refresh':
      case 'sync':
        return await handleRefresh(rest[0]);
      case 'enable':
        return await handleEnable(rest[0]);
      case 'disable':
        return await handleDisable(rest[0]);
      case 'buy':
        return await handleBuy(rest);
      case 'sell':
        return await handleSell(rest);
      case 'position':
      case 'pos':
        return await handlePosition(rest[0]);
      case 'help':
      default:
        return await handleHelp();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `❌ **Error:** ${msg}`;
  }
}

export default { execute };

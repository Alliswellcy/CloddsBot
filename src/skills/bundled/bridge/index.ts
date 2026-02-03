/**
 * Bridge CLI Skill
 *
 * Commands:
 * /bridge <amount> <token> from <chain> to <chain> - Bridge tokens
 * /bridge quote <amount> <token> from <chain> to <chain> - Get quote
 * /bridge status <txHash> - Check bridge status
 * /bridge routes <token> - Show available routes
 */

async function execute(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() || 'help';

  try {
    const wormhole = await import('../../../bridge/wormhole');

    switch (cmd) {
      case 'quote': {
        // /bridge quote 100 USDC from ethereum to base
        const amount = parseFloat(parts[1] || '');
        if (isNaN(amount) || parts.length < 7) {
          return 'Usage: /bridge quote <amount> <token> from <chain> to <chain>';
        }
        const token = parts[2]?.toUpperCase();
        const fromChain = parts[4];
        const toChain = parts[6];

        const quote: any = await wormhole.wormholeQuote({
          source_chain: fromChain,
          destination_chain: toChain,
          destination_address: '',
          amount: amount.toString(),
          amount_units: 'human',
        });

        let output = `**Bridge Quote: ${amount} ${token}**\n\n`;
        output += `From: ${fromChain}\nTo: ${toChain}\n`;
        output += `Protocol: ${quote.protocol || 'Wormhole'}\n`;
        if (quote.relayerFee) output += `Relayer fee: ${quote.relayerFee}\n`;
        if (quote.estimatedTime) output += `Estimated time: ${quote.estimatedTime}\n`;
        return output;
      }

      case 'usdc': {
        // /bridge usdc 100 from ethereum to base
        const amount = parseFloat(parts[1] || '');
        if (isNaN(amount) || parts.length < 6) {
          return 'Usage: /bridge usdc <amount> from <chain> to <chain>';
        }
        const fromChain = parts[3];
        const toChain = parts[5];

        const quote: any = await wormhole.usdcQuoteAuto({
          source_chain: fromChain,
          destination_chain: toChain,
          destination_address: '',
          amount: amount.toString(),
          amount_units: 'human',
        });

        let output = `**USDC Bridge Quote (CCTP)**\n\n`;
        output += `Amount: ${amount} USDC\n`;
        output += `From: ${fromChain}\nTo: ${toChain}\n`;
        output += `Protocol: CCTP (Circle)\n`;
        if (quote.relayerFee) output += `Fee: ${quote.relayerFee}\n`;
        return output;
      }

      case 'redeem': {
        if (!parts[1]) return 'Usage: /bridge redeem <source-txid> --from <chain> --to <chain>';
        const txid = parts[1];
        const fromIdx = parts.indexOf('--from');
        const toIdx = parts.indexOf('--to');
        const fromChain = fromIdx >= 0 ? parts[fromIdx + 1] : '';
        const toChain = toIdx >= 0 ? parts[toIdx + 1] : '';
        if (!fromChain || !toChain) return 'Usage: /bridge redeem <source-txid> --from <chain> --to <chain>';

        const result: any = await wormhole.wormholeRedeem({
          source_chain: fromChain,
          destination_chain: toChain,
          source_txid: txid,
        });

        return `**Bridge Redeem**\n\nSource TX: \`${txid}\`\nFrom: ${fromChain}\nTo: ${toChain}\nStatus: ${result.status || 'submitted'}`;
      }

      case 'status': {
        if (!parts[1]) return 'Usage: /bridge status <txHash>';
        const txHash = parts[1];

        // Query Wormholescan public API for transfer status
        const resp = await fetch(`https://api.wormholescan.io/api/v1/operations?txHash=${txHash}`);
        if (!resp.ok) {
          return `**Bridge Status**\n\nTx: \`${txHash}\`\nCould not fetch status (HTTP ${resp.status}). Check manually: https://wormholescan.io/#/tx/${txHash}`;
        }
        const statusData: any = await resp.json();
        const ops = statusData.operations || [];
        if (ops.length === 0) {
          return `**Bridge Status**\n\nTx: \`${txHash}\`\nNo transfer found yet. It may still be processing.\nTrack: https://wormholescan.io/#/tx/${txHash}`;
        }
        const op = ops[0];
        let statusOutput = `**Bridge Status**\n\nTx: \`${txHash}\`\n`;
        statusOutput += `Status: ${op.status || 'unknown'}\n`;
        if (op.sourceChain) statusOutput += `Source: ${op.sourceChain.chainName || op.sourceChain.chainId || 'unknown'}\n`;
        if (op.targetChain) statusOutput += `Destination: ${op.targetChain.chainName || op.targetChain.chainId || 'unknown'}\n`;
        if (op.data?.tokenAmount) statusOutput += `Amount: ${op.data.tokenAmount}\n`;
        if (op.data?.symbol) statusOutput += `Token: ${op.data.symbol}\n`;
        if (op.vaa?.timestamp) statusOutput += `Timestamp: ${new Date(op.vaa.timestamp).toLocaleString()}\n`;
        statusOutput += `\nExplorer: https://wormholescan.io/#/tx/${txHash}`;
        return statusOutput;
      }

      case 'routes': {
        const token = (parts[1] || 'USDC').toUpperCase();
        // Query Wormholescan for supported chains
        try {
          const chainsResp = await fetch('https://api.wormholescan.io/api/v1/governor/available-notional-by-chain');
          if (chainsResp.ok) {
            const chainsData: any = await chainsResp.json();
            const entries = chainsData.entries || [];
            if (entries.length > 0) {
              let routeOutput = `**Bridge Routes for ${token}**\n\n`;
              routeOutput += `| Chain | Chain ID | Available Notional |\n`;
              routeOutput += `|-------|----------|--------------------|\n`;
              for (const entry of entries.slice(0, 20)) {
                const chainName = entry.chainName || `Chain ${entry.chainId}`;
                const notional = entry.remainingAvailableNotional
                  ? `$${parseFloat(entry.remainingAvailableNotional).toLocaleString()}`
                  : 'N/A';
                routeOutput += `| ${chainName} | ${entry.chainId} | ${notional} |\n`;
              }
              routeOutput += `\nProtocols: Wormhole Token Bridge, Circle CCTP (USDC)`;
              return routeOutput;
            }
          }
        } catch { /* fall through to static */ }

        // Fallback static routes if API fails
        return `**Bridge Routes for ${token}**\n\n` +
          `| From | To | Protocol | Type |\n` +
          `|------|----|----------|------|\n` +
          `| Ethereum | Base | CCTP | Native USDC |\n` +
          `| Ethereum | Polygon | Wormhole | Token Bridge |\n` +
          `| Ethereum | Solana | Wormhole | Token Bridge |\n` +
          `| Polygon | Base | CCTP | Native USDC |\n` +
          `| Solana | Ethereum | Wormhole | Token Bridge |\n` +
          `| Base | Ethereum | CCTP | Native USDC |`;
      }

      case 'help':
        return helpText();

      default: {
        // Parse: <amount> <token> from <chain> to <chain>
        const amount = parseFloat(parts[0] || '');
        if (!isNaN(amount) && parts.length >= 5) {
          const token = parts[1]?.toUpperCase();
          const fromChain = parts[3];
          const toChain = parts[5];

          if (token === 'USDC') {
            const result: any = await wormhole.usdcBridgeAuto({
              source_chain: fromChain,
              destination_chain: toChain,
              destination_address: '',
              amount: amount.toString(),
              amount_units: 'human',
            });

            return `**USDC Bridge Initiated (CCTP)**\n\n` +
              `Amount: ${amount} USDC\nFrom: ${fromChain}\nTo: ${toChain}\n` +
              `Status: ${result.status || 'submitted'}\n` +
              `TX: \`${result.sourceTxHash || 'pending'}\``;
          }

          const result: any = await wormhole.wormholeBridge({
            source_chain: fromChain,
            destination_chain: toChain,
            destination_address: '',
            amount: amount.toString(),
            amount_units: 'human',
          });

          return `**Bridge Initiated**\n\n` +
            `Amount: ${amount} ${token}\nFrom: ${fromChain}\nTo: ${toChain}\n` +
            `Protocol: Wormhole Token Bridge\n` +
            `Status: ${result.status || 'submitted'}`;
        }
        return helpText();
      }
    }
  } catch {
    return helpText();
  }
}

function helpText(): string {
  return `**Bridge Commands**

  /bridge <amount> <token> from <chain> to <chain>  - Bridge tokens
  /bridge quote <amount> <token> from <chain> to <chain> - Get quote
  /bridge usdc <amount> from <chain> to <chain>      - USDC via CCTP
  /bridge redeem <txid> --from <chain> --to <chain>  - Redeem transfer
  /bridge status <txHash>                            - Check status
  /bridge routes [token]                             - Available routes

**Supported chains:** Ethereum, Polygon, Base, Solana, Arbitrum, Optimism
**Protocols:** Wormhole Token Bridge, Circle CCTP`;
}

export default {
  name: 'bridge',
  description: 'Cross-chain token transfers using Wormhole and CCTP',
  commands: ['/bridge'],
  handle: execute,
};

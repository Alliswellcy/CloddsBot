<p align="center">
  <img src="https://cloddsbot.com/logo.png" alt="Clodds" width="200">
</p>

<h3 align="center">AI Trading Terminal</h3>

<p align="center">
  Trade prediction markets, crypto & futures through natural conversation.
  <br />
  <a href="https://cloddsbot.com/docs"><strong>Docs</strong></a> · <a href="#quick-start"><strong>Quick Start</strong></a> · <a href="https://api.cloddsbot.com"><strong>API</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node">
  <img src="https://img.shields.io/badge/typescript-5.3-blue" alt="TypeScript">
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="License">
</p>

---

## Quick Start

```bash
git clone https://github.com/alsk1992/CloddsBot.git && cd CloddsBot
npm install && cp .env.example .env
# Add ANTHROPIC_API_KEY to .env
npm run build && npm start
```

Open `http://localhost:18789/webchat` — no account needed.

---

## What You Can Do

**Trade** across 9 prediction markets (Polymarket, Kalshi, Betfair) and 4 futures exchanges (Binance, Bybit, Hyperliquid, MEXC) with up to 200x leverage.

**Chat** via 22 platforms — Telegram, Discord, Slack, WhatsApp, and more.

**Automate** with copy trading, whale tracking, arbitrage detection, and custom bots.

**DeFi** on Solana (Jupiter, Raydium, Orca) and EVM chains (Uniswap, 1inch) with MEV protection.

---

## Examples

```
"Buy $100 of Trump YES on Polymarket"
"What's the arbitrage between Poly and Kalshi on the election?"
"Open a 10x long on BTC with stop loss at 95k"
"Copy trade the top Polymarket whale"
"Alert me when ETH drops below 3000"
```

---

## Compute API

Agents can pay USDC for compute — no API keys needed, just a wallet.

```bash
curl https://api.cloddsbot.com/v1/health
curl https://api.cloddsbot.com/v1/pricing
```

| Service | Price | Description |
|---------|-------|-------------|
| `llm` | $0.000003/token | Claude, GPT-4, Llama |
| `code` | $0.001/sec | Sandboxed execution |
| `web` | $0.005/req | Scraping with JS |
| `data` | $0.001/req | Market data |
| `trade` | $0.01/call | Order execution |

**SDK:**
```typescript
import { CloddsClient } from '@clodds/sdk';

const client = new CloddsClient({ wallet: '0x...' });
const response = await client.llm({
  model: 'claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

[Full API Docs →](./docs/API.md)

---

## Platform Support

<table>
<tr>
<td width="33%">

**Prediction Markets**
- Polymarket
- Kalshi
- Betfair
- Smarkets
- Drift
- Manifold
- Metaculus
- PredictIt

</td>
<td width="33%">

**Futures Exchanges**
- Binance (125x)
- Bybit (100x)
- Hyperliquid (50x)
- MEXC (200x)

</td>
<td width="33%">

**Messaging**
- Telegram
- Discord
- Slack
- WhatsApp
- Teams
- Matrix
- Signal
- +15 more

</td>
</tr>
</table>

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Arbitrage Detection** | Cross-platform and combinatorial opportunities |
| **Whale Tracking** | Follow large traders on Polymarket + multi-chain crypto |
| **Copy Trading** | Mirror successful wallets automatically |
| **Smart Routing** | Best price across platforms |
| **Risk Management** | Circuit breakers, position limits, stop-loss |
| **Backtesting** | Validate strategies before deploying |

---

## CLI

```bash
clodds start          # Start the gateway
clodds repl           # Interactive REPL
clodds doctor         # Run diagnostics
clodds secure         # Harden security
```

---

## Configuration

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Trading (optional)
POLYMARKET_API_KEY=...
KALSHI_API_KEY=...
BINANCE_API_KEY=...

# Messaging (pick any)
TELEGRAM_BOT_TOKEN=...
DISCORD_BOT_TOKEN=...
```

---

## Documentation

- [User Guide](./docs/USER_GUIDE.md) — Commands and daily usage
- [Trading](./docs/TRADING.md) — Execution, bots, safety
- [API Reference](./docs/API.md) — HTTP endpoints
- [Deployment](./docs/DEPLOYMENT_GUIDE.md) — Production setup
- [Security](./docs/SECURITY_AUDIT.md) — Hardening guide

---

## Development

```bash
npm run dev          # Hot reload
npm test             # Tests
npm run typecheck    # Type check
```

---

## License

MIT

---

<p align="center">
  <sub>Built with Claude</sub>
</p>

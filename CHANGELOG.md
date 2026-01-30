# Changelog

All notable changes to Clodds will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-01-30

### Added

#### Trading Platforms
- **9 Prediction Markets**: Polymarket, Kalshi, Betfair, Smarkets, Drift, Manifold, Metaculus, PredictIt
- **4 Futures Exchanges**: Binance (125x), Bybit (100x), Hyperliquid (50x), MEXC (200x)
- **5 Solana DEXs**: Jupiter, Raydium, Orca, Meteora, Pump.fun
- **5 EVM Chains**: Ethereum, Arbitrum, Optimism, Base, Polygon via Uniswap V3 & 1inch
- **700+ markets** available for trading

#### Messaging Channels (22)
- Telegram, Discord, Slack, WhatsApp, Microsoft Teams
- Matrix, Signal, Google Chat, iMessage (BlueBubbles), LINE
- Mattermost, Nextcloud Talk, Zalo, Nostr, Tlon/Urbit
- Twitch, Voice, WebChat, IRC
- Email (SMTP), SMS (Twilio), Webhooks

#### Smart Trading
- Cross-platform, internal, and combinatorial arbitrage detection
- Multi-chain whale tracking (Solana, ETH, Polygon, ARB, Base, OP)
- Copy trading with configurable sizing and SL/TP
- MEV protection (Flashbots, MEV Blocker, Jito)
- Smart order routing (best price/liquidity/fees)
- Order splitting and TWAP execution

#### Risk Management
- Kelly criterion position sizing (full, half, quarter)
- Circuit breakers with auto-halt
- Stop-loss, take-profit, trailing stops
- Daily loss limits, max drawdown protection
- Position size limits, consecutive loss limits
- Emergency kill switch

#### Strategy & Analytics
- Natural language strategy builder
- Backtesting with Monte Carlo simulation
- Walk-forward analysis
- Performance attribution by edge source
- Time-of-day analysis
- Sharpe ratio, profit factor, win rate tracking

#### AI System
- 6 LLM providers (Anthropic, OpenAI, Google, Groq, Together, Ollama)
- 4 specialized agents (Main, Trading, Research, Alerts)
- 21 AI tools
- Semantic memory with vector embeddings
- Hybrid search (BM25 + semantic)

#### Skills (61)
- Complete skill definitions with chat commands
- TypeScript API references for all skills
- Organized by category: Trading, Data, Analysis, Risk, Automation, AI, Infrastructure

#### Documentation
- 170+ term glossary
- Comprehensive README
- Frontend docs at cloddsbot.com

#### Infrastructure
- MCP server support
- Webhook integrations
- Background job processing
- Sandboxed code execution
- Tailscale VPN sharing
- x402 machine-to-machine payments
- Wormhole cross-chain bridging

### Security
- Encrypted credentials (AES-256-GCM)
- Sandboxed command execution
- Rate limiting per platform
- Audit logging for all trades

---

[0.1.0]: https://github.com/alsk1992/CloddsBot/releases/tag/v0.1.0

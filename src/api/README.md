# Clodds Hosted API

Pay-per-prompt API gateway using x402 protocol.

## Quick Start

```typescript
import { createApiGateway } from './api';

const api = createApiGateway({
  port: 3001,
  pricing: {
    basic: 0.05,      // Simple queries
    standard: 0.10,   // Trades, swaps
    complex: 0.25,    // Multi-step automation
  },
  x402: {
    network: 'base',
    privateKey: process.env.CLODDS_API_KEY,
  },
  custody: {
    enabled: true,
    masterKey: process.env.CLODDS_MASTER_KEY,
  },
});

await api.start();
console.log(`API running at ${api.getUrl()}`);
```

## Endpoints

### POST /v2/prompt
Submit a natural language prompt for execution.

**Request:**
```json
{
  "prompt": "Buy 100 USDC of YES shares on Trump wins",
  "wallet": "0x...",
  "callbackUrl": "https://yourapp.com/webhook"
}
```

**Response (202 Accepted):**
```json
{
  "id": "req_abc123",
  "jobId": "job_xyz789",
  "status": "pending",
  "cost": 0.10,
  "tier": "standard",
  "timestamp": 1706880000000
}
```

**Payment Required (402):**
```json
{
  "error": "Payment Required",
  "amount": 0.10,
  "currency": "USD",
  "tier": "standard",
  "paymentAddress": "0x...",
  "protocol": "x402"
}
```

### GET /v2/job/:id
Check job status.

**Response:**
```json
{
  "id": "req_abc123",
  "jobId": "job_xyz789",
  "status": "completed",
  "result": {
    "action": "trade",
    "summary": "Bought 100 YES shares at $0.52",
    "data": { ... },
    "transaction": {
      "hash": "0x...",
      "chain": "polygon",
      "status": "confirmed"
    }
  },
  "cost": 0.10,
  "tier": "standard"
}
```

### POST /v2/job/:id/cancel
Cancel a pending job.

### GET /v2/jobs
List jobs for a wallet (requires X-Wallet-Address header).

### GET /v2/wallet
Get or create managed custody wallet.

### GET /health
Health check.

### GET /metrics
API metrics (requires auth).

## x402 Payment Flow

1. Client sends POST /v2/prompt without payment
2. Server returns 402 with payment details:
   - `X-Payment-Address`: Where to send payment
   - `X-Payment-Amount`: Amount in USD
   - `X-Payment-Token`: USDC contract address
   - `X-Payment-Network`: base
3. Client pays via x402 protocol
4. Client retries with `X-Payment-Proof` header (base64 JSON)
5. Server verifies payment and processes prompt

## Pricing Tiers

| Tier | Price | Examples |
|------|-------|----------|
| Basic | $0.05 | Price checks, balances, lookups |
| Standard | $0.10 | Trades, swaps, transfers |
| Complex | $0.25 | Multi-step, automation, copy trading |

## Architecture

```
src/api/
├── index.ts        # Main exports
├── types.ts        # Type definitions
├── gateway.ts      # HTTP server & routing
├── middleware.ts   # x402 payment verification
├── jobs.ts         # Async job queue
├── prompt.ts       # Prompt classification & execution
└── custody.ts      # Managed wallet system
```

## Environment Variables

```bash
CLODDS_API_PORT=3001
CLODDS_API_KEY=0x...           # Server private key for payments
CLODDS_MASTER_KEY=...          # Custody encryption key
CLODDS_DRY_RUN=true            # Skip actual execution
```

## Comparison vs Bankr

| Feature | Bankr | Clodds |
|---------|-------|--------|
| Price | $0.10/prompt | $0.05-0.25 tiered |
| Chains | 4 | 8+ |
| Prediction Markets | 1 | 9 |
| Copy Trading | No | Yes |
| Signals | No | Yes |
| Open Source | No | Yes |

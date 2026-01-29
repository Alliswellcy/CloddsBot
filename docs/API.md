# Clodds API

This document describes the HTTP and WebSocket endpoints exposed by the Clodds gateway.

## Base URL

By default the gateway binds to loopback and listens on port 18789.

```
http://127.0.0.1:18789
```

## Authentication and security

- HTTP endpoints do not enforce authentication by default. Protect the gateway with network controls or a reverse proxy if you expose it publicly.
- WebChat supports an optional token. Set `WEBCHAT_TOKEN` and send it in the WebSocket auth message.
- Webhooks require HMAC signatures by default. See the webhook section below.

## HTTP endpoints

### GET /health

Basic health check.

Response:
```
{ "status": "ok", "timestamp": 1730000000000 }
```

### GET /

API info and supported endpoints.

Response:
```
{
  "name": "clodds",
  "version": "0.1.0",
  "description": "AI assistant for prediction markets",
  "endpoints": { "websocket": "/ws", "webchat": "/chat", "health": "/health" }
}
```

### GET /webchat

Returns a simple HTML client that connects to the WebChat WebSocket endpoint (`/chat`).

### POST /webhook or /webhook/*

Generic webhook endpoint for automation hooks.

Headers:
- `x-webhook-signature` or `x-hub-signature-256` (required by default)

Signature:
- HMAC SHA-256 hex digest of the raw request body using the webhook secret.
- To disable signature requirements, set `CLODDS_WEBHOOK_REQUIRE_SIGNATURE=0`.

Responses:
- `200 { "ok": true }` on success
- `401` for missing/invalid signatures
- `404` for unknown webhook paths
- `429` if rate limited

### POST /channels/:platform

Channel webhook entrypoint for platforms like Teams, Google Chat, etc.

Behavior:
- Forwards the JSON body to the configured channel adapter.
- Returns `404` if that platform handler is not configured.

### GET /market-index/search

Search the market index (requires `marketIndex.enabled`).

Query parameters:
- `q` (string, required): search text
- `platform` (string, optional): `polymarket|kalshi|manifold|metaculus`
- `limit` (number, optional)
- `maxCandidates` (number, optional)
- `minScore` (number, optional)
- `platformWeights` (JSON string, optional)

Response:
```
{
  "results": [
    {
      "score": 0.8421,
      "market": {
        "platform": "polymarket",
        "id": "123",
        "slug": "will-x-happen",
        "question": "...",
        "description": "...",
        "url": "...",
        "status": "open",
        "endDate": "2026-01-01T00:00:00.000Z",
        "resolved": false,
        "volume24h": 1234,
        "liquidity": 5678,
        "openInterest": 910,
        "predictions": 42
      }
    }
  ]
}
```

### GET /market-index/stats

Market index stats (requires `marketIndex.enabled`).

Query parameters:
- `platforms` (comma-separated list, optional)

### POST /market-index/sync

Trigger a manual market index sync (requires `marketIndex.enabled`).

Body (JSON):
- `platforms` (array or comma-separated string, optional)
- `limitPerPlatform` (number, optional)
- `status` (`open|closed|settled|all`, optional)
- `excludeSports` (boolean, optional)
- `minVolume24h` (number, optional)
- `minLiquidity` (number, optional)
- `minOpenInterest` (number, optional)
- `minPredictions` (number, optional)
- `excludeResolved` (boolean, optional)
- `prune` (boolean, optional)
- `staleAfterMs` (number, optional)

Response:
```
{ "result": { "indexed": 123, "byPlatform": { "polymarket": 100 } } }
```

## WebSocket endpoints

### WS /ws

Development WebSocket endpoint. Currently echoes incoming JSON with a wrapper:

```
{ "type": "res", "id": "<client id>", "ok": true, "payload": { "echo": <message> } }
```

### WS /chat (WebChat)

WebChat WebSocket endpoint used by `/webchat`.

Client messages:
- `auth`: `{ "type": "auth", "token": "<WEBCHAT_TOKEN>", "userId": "web-123" }`
- `message`: `{ "type": "message", "text": "hi", "attachments": [] }`
- `edit`: `{ "type": "edit", "messageId": "<id>", "text": "new text" }`
- `delete`: `{ "type": "delete", "messageId": "<id>" }`

Server messages:
- `connected`, `authenticated`, `ack`, `message`, `edit`, `delete`, `error`

Attachment fields (if provided):
- `type`: `image|video|audio|document|voice|sticker`
- `url` or `data` (base64)
- `mimeType`, `filename`, `size`, `width`, `height`, `duration`, `caption`

/**
 * HTTP + WebSocket server
 */

import express, { Request } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createHttpServer, Server, IncomingMessage } from 'http';
import { logger } from '../utils/logger';
import type { Config } from '../types';
import type { WebhookManager } from '../automation/webhooks';
import { createWebhookMiddleware } from '../automation/webhooks';

export interface GatewayServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getWebSocketServer(): WebSocketServer | null;
  setChannelWebhookHandler(handler: ChannelWebhookHandler | null): void;
  setMarketIndexHandler(handler: MarketIndexHandler | null): void;
  setMarketIndexStatsHandler(handler: MarketIndexStatsHandler | null): void;
  setMarketIndexSyncHandler(handler: MarketIndexSyncHandler | null): void;
}

export type ChannelWebhookHandler = (
  platform: string,
  event: unknown,
  req: Request
) => Promise<unknown>;

export type MarketIndexHandler = (
  req: Request
) => Promise<{ results: unknown[] } | { error: string; status?: number }>;

export type MarketIndexStatsHandler = (
  req: Request
) => Promise<{ stats: unknown } | { error: string; status?: number }>;

export type MarketIndexSyncHandler = (
  req: Request
) => Promise<{ result: unknown } | { error: string; status?: number }>;

export function createServer(config: Config['gateway'], webhooks?: WebhookManager): GatewayServer {
  const app = express();
  let httpServer: Server | null = null;
  let wss: WebSocketServer | null = null;
  let channelWebhookHandler: ChannelWebhookHandler | null = null;
  let marketIndexHandler: MarketIndexHandler | null = null;
  let marketIndexStatsHandler: MarketIndexStatsHandler | null = null;
  let marketIndexSyncHandler: MarketIndexSyncHandler | null = null;

  const corsConfig = config.cors ?? false;
  app.use((req, res, next) => {
    if (!corsConfig) {
      return next();
    }

    const originHeader = req.headers.origin;
    let origin = '*';
    if (Array.isArray(corsConfig)) {
      origin = originHeader && corsConfig.includes(originHeader) ? originHeader : '';
    } else if (corsConfig === true) {
      origin = '*';
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      // Capture raw body for webhook signature verification
      (req as any).rawBody = buf.toString();
    },
  }));

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // API info endpoint
  app.get('/', (_req, res) => {
    res.json({
      name: 'clodds',
      version: '0.1.0',
      description: 'AI assistant for prediction markets',
      endpoints: {
        websocket: '/ws',
        webchat: '/chat',
        health: '/health',
      },
    });
  });

  // Serve simple WebChat HTML client
  app.get('/webchat', (_req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Clodds WebChat</title>
  <style>
    body { font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 20px; }
    #messages { height: 400px; overflow-y: auto; border: 1px solid #ccc; padding: 10px; margin-bottom: 10px; }
    .msg { margin: 5px 0; padding: 8px; border-radius: 4px; }
    .user { background: #e3f2fd; text-align: right; }
    .bot { background: #f5f5f5; }
    .system { background: #fff3e0; font-style: italic; font-size: 0.9em; }
    #input { width: calc(100% - 80px); padding: 10px; }
    button { padding: 10px 20px; }
  </style>
</head>
<body>
  <h1>🎲 Clodds WebChat</h1>
  <div id="messages"></div>
  <input type="text" id="input" placeholder="Ask about prediction markets..." />
  <button onclick="send()">Send</button>
  <script>
    const port = window.location.port || 80;
    const ws = new WebSocket('ws://' + window.location.hostname + ':' + port + '/chat');
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');

    function addMsg(text, cls, messageId) {
      const div = document.createElement('div');
      div.className = 'msg ' + cls;
      if (messageId) {
        div.dataset.messageId = messageId;
      }
      div.textContent = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function getToken() {
      const params = new URLSearchParams(window.location.search);
      const queryToken = params.get('token');
      if (queryToken) {
        localStorage.setItem('webchat_token', queryToken);
        return queryToken;
      }
      const saved = localStorage.getItem('webchat_token');
      if (saved) return saved;
      const promptToken = window.prompt('Enter WebChat token (leave blank for none):');
      if (promptToken) {
        localStorage.setItem('webchat_token', promptToken);
        return promptToken;
      }
      return '';
    }

    ws.onopen = () => {
      addMsg('Connected. Authenticating...', 'system');
      const token = getToken();
      ws.send(JSON.stringify({ type: 'auth', token, userId: 'web-' + Date.now() }));
    };

    function renderAttachments(attachments) {
      if (!Array.isArray(attachments) || attachments.length === 0) return [];
      const nodes = [];
      for (const attachment of attachments) {
        const resolvedUrl = attachment.url || (attachment.data && attachment.mimeType
          ? 'data:' + attachment.mimeType + ';base64,' + attachment.data
          : null);
        if (attachment.type === 'image' && resolvedUrl) {
          const img = document.createElement('img');
          img.src = resolvedUrl || '';
          img.style.maxWidth = '100%';
          img.style.display = 'block';
          img.style.marginTop = '6px';
          nodes.push(img);
          continue;
        }
        if ((attachment.type === 'video' || attachment.type === 'audio') && resolvedUrl) {
          const media = document.createElement(attachment.type === 'video' ? 'video' : 'audio');
          media.src = resolvedUrl;
          media.controls = true;
          media.style.width = '100%';
          media.style.marginTop = '6px';
          nodes.push(media);
          continue;
        }
        const link = document.createElement('a');
        link.href = resolvedUrl || '#';
        link.textContent = attachment.filename || attachment.mimeType || 'attachment';
        link.style.display = 'block';
        link.style.marginTop = '6px';
        link.target = '_blank';
        nodes.push(link);
      }
      return nodes;
    }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'authenticated') {
        addMsg('Ready! Ask me about prediction markets.', 'system');
      } else if (msg.type === 'message') {
        const wrapper = document.createElement('div');
        wrapper.className = 'msg bot';
        if (msg.messageId) {
          wrapper.dataset.messageId = msg.messageId;
        }
        const textNode = document.createElement('div');
        textNode.textContent = msg.text || '';
        wrapper.appendChild(textNode);
        const nodes = renderAttachments(msg.attachments || []);
        for (const node of nodes) wrapper.appendChild(node);
        messages.appendChild(wrapper);
        messages.scrollTop = messages.scrollHeight;
      } else if (msg.type === 'edit') {
        const node = Array.from(messages.children)
          .find((child) => child.dataset && child.dataset.messageId === msg.messageId);
        if (node) {
          node.textContent = msg.text || '';
        }
      } else if (msg.type === 'delete') {
        const node = Array.from(messages.children)
          .find((child) => child.dataset && child.dataset.messageId === msg.messageId);
        if (node) {
          node.remove();
        }
      } else if (msg.type === 'error') {
        addMsg('Error: ' + msg.message, 'system');
      }
    };

    ws.onclose = () => addMsg('Disconnected', 'system');

    function send() {
      const text = input.value.trim();
      if (text) {
        addMsg(text, 'user');
        ws.send(JSON.stringify({ type: 'message', text }));
        input.value = '';
      }
    }

    input.addEventListener('keypress', (e) => { if (e.key === 'Enter') send(); });
  </script>
</body>
</html>
    `);
  });

  if (webhooks) {
    const webhookMiddleware = createWebhookMiddleware(webhooks);
    app.post('/webhook/*', webhookMiddleware);
    app.post('/webhook', webhookMiddleware);
  }

  // Channel webhooks (Teams, Google Chat, etc.)
  app.post('/channels/:platform', async (req, res) => {
    if (!channelWebhookHandler) {
      res.status(404).json({ error: 'Channel webhooks not configured' });
      return;
    }

    const platform = req.params.platform;
    try {
      const result = await channelWebhookHandler(platform, req.body, req);

      if (result === null || result === undefined) {
        res.status(200).send();
        return;
      }

      if (typeof result === 'string') {
        res.json({ text: result });
        return;
      }

      res.json(result);
    } catch (error) {
      logger.error({ error, platform }, 'Channel webhook handler failed');
      res.status(500).json({ error: 'Channel webhook error' });
    }
  });

  // Market index search endpoint
  app.get('/market-index/search', async (req, res) => {
    if (!marketIndexHandler) {
      res.status(404).json({ error: 'Market index handler not configured' });
      return;
    }

    try {
      const result = await marketIndexHandler(req);
      if ('error' in result) {
        res.status(result.status ?? 400).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      logger.error({ error }, 'Market index handler failed');
      res.status(500).json({ error: 'Market index error' });
    }
  });

  app.get('/market-index/stats', async (req, res) => {
    if (!marketIndexStatsHandler) {
      res.status(404).json({ error: 'Market index handler not configured' });
      return;
    }

    try {
      const result = await marketIndexStatsHandler(req);
      if ('error' in result) {
        res.status(result.status ?? 400).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      logger.error({ error }, 'Market index stats handler failed');
      res.status(500).json({ error: 'Market index error' });
    }
  });

  app.post('/market-index/sync', async (req, res) => {
    if (!marketIndexSyncHandler) {
      res.status(404).json({ error: 'Market index handler not configured' });
      return;
    }

    try {
      const result = await marketIndexSyncHandler(req);
      if ('error' in result) {
        res.status(result.status ?? 400).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      logger.error({ error }, 'Market index sync handler failed');
      res.status(500).json({ error: 'Market index error' });
    }
  });

  return {
    async start() {
      return new Promise((resolve) => {
        httpServer = createHttpServer(app);

        // WebSocket server - handles both /ws and /chat
        wss = new WebSocketServer({ noServer: true });

        // Handle upgrade requests
        httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
          const pathname = request.url || '';

          if (pathname === '/ws' || pathname === '/chat') {
            wss!.handleUpgrade(request, socket, head, (ws) => {
              wss!.emit('connection', ws, request);
            });
          } else {
            socket.destroy();
          }
        });

        // Default /ws handler (for API/control)
        wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
          // /chat connections are handled by WebChat channel via attachWebSocket
          if (request.url === '/chat') {
            return; // Let WebChat handle it
          }

          logger.info('WebSocket API client connected');

          ws.on('message', (data) => {
            try {
              const message = JSON.parse(data.toString());
              logger.debug({ message }, 'WS API message received');

              ws.send(
                JSON.stringify({
                  type: 'res',
                  id: message.id,
                  ok: true,
                  payload: { echo: message },
                })
              );
            } catch (err) {
              logger.error({ err }, 'Failed to parse WS message');
            }
          });

          ws.on('close', () => {
            logger.info('WebSocket API client disconnected');
          });
        });

        httpServer.listen(config.port, () => {
          resolve();
        });
      });
    },

    async stop() {
      return new Promise((resolve) => {
        wss?.close();
        httpServer?.close(() => resolve());
      });
    },

    getWebSocketServer(): WebSocketServer | null {
      return wss;
    },

    setChannelWebhookHandler(handler: ChannelWebhookHandler | null): void {
      channelWebhookHandler = handler;
    },

    setMarketIndexHandler(handler: MarketIndexHandler | null): void {
      marketIndexHandler = handler;
    },
    setMarketIndexStatsHandler(handler: MarketIndexStatsHandler | null): void {
      marketIndexStatsHandler = handler;
    },
    setMarketIndexSyncHandler(handler: MarketIndexSyncHandler | null): void {
      marketIndexSyncHandler = handler;
    },
  };
}

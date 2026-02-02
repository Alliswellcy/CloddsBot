/**
 * Standalone Compute API Server
 *
 * Run independently: npx ts-node src/api/server.ts
 * Or after build: node dist/api/server.js
 */

import { createServer } from 'http';
import { createComputeGateway, COMPUTE_PRICING } from './compute';
import { createLLMService } from './compute/llm';
import { createCodeRunner } from './compute/code';
import { createWebScraper } from './compute/web';
import { createDataService } from './compute/data';
import { createStorageService } from './compute/storage';
import type { ComputeRequest, ComputeService } from './compute/types';

const PORT = parseInt(process.env.CLODDS_API_PORT || '3456', 10);
const TREASURY = process.env.CLODDS_TREASURY_WALLET;

if (!TREASURY) {
  console.error('ERROR: CLODDS_TREASURY_WALLET env var not set');
  process.exit(1);
}

console.log(`Starting Clodds Compute API...`);
console.log(`Treasury: ${TREASURY}`);
console.log(`Port: ${PORT}`);

// Initialize services
const gateway = createComputeGateway({ treasuryWallet: TREASURY }, COMPUTE_PRICING);
const llm = createLLMService();
const code = createCodeRunner();
const web = createWebScraper();
const data = createDataService();
const storage = createStorageService();

// Service handlers
const handlers: Record<ComputeService, (req: ComputeRequest) => Promise<unknown>> = {
  llm: (req) => llm.execute(req),
  code: (req) => code.execute(req),
  web: (req) => web.execute(req),
  trade: async () => { throw new Error('Trade service requires additional config'); },
  data: (req) => data.execute(req),
  storage: (req) => storage.execute(req),
  gpu: async () => { throw new Error('GPU service not yet available'); },
  ml: async () => { throw new Error('ML service not yet available'); },
};

// Simple HTTP server
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Powered-By', 'Clodds Compute');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'clodds-compute',
      treasury: TREASURY,
      services: Object.keys(COMPUTE_PRICING),
    }));
    return;
  }

  // Pricing info
  if (url.pathname === '/pricing') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(COMPUTE_PRICING));
    return;
  }

  // Balance check: GET /balance/:wallet
  if (url.pathname.startsWith('/balance/')) {
    const wallet = url.pathname.split('/')[2];
    const balance = await gateway.getBalance(wallet);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(balance));
    return;
  }

  // Job status: GET /job/:jobId
  if (url.pathname.startsWith('/job/') && req.method === 'GET') {
    const jobId = url.pathname.split('/')[2];
    const job = await gateway.getJob(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(job));
    return;
  }

  // Submit compute request: POST /compute/:service
  if (url.pathname.startsWith('/compute/') && req.method === 'POST') {
    const service = url.pathname.split('/')[2] as ComputeService;

    if (!COMPUTE_PRICING[service]) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Unknown service: ${service}` }));
      return;
    }

    // Parse body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    try {
      const payload = JSON.parse(body);

      if (!payload.wallet) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'wallet is required' }));
        return;
      }

      const computeReq: ComputeRequest = {
        id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        service,
        wallet: payload.wallet,
        payload: payload.payload || payload,
        paymentProof: payload.paymentProof,
        callbackUrl: payload.callbackUrl,
        meta: payload.meta,
      };

      const result = await gateway.submit(computeReq);

      res.writeHead(result.status === 'failed' ? 400 : 202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid request' }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`\n✓ Clodds Compute API running on http://0.0.0.0:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /health          - Health check`);
  console.log(`  GET  /pricing         - Service pricing`);
  console.log(`  GET  /balance/:wallet - Check wallet balance`);
  console.log(`  GET  /job/:jobId      - Get job status`);
  console.log(`  POST /compute/:service - Submit compute request`);
  console.log(`\nServices: ${Object.keys(COMPUTE_PRICING).join(', ')}`);
});

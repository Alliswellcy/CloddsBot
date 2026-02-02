/**
 * Clodds Compute SDK - TypeScript client for the Compute API
 *
 * Usage:
 * ```typescript
 * import { CloddsClient } from './sdk';
 *
 * const client = new CloddsClient({
 *   baseUrl: 'https://api.clodds.com',
 *   wallet: '0x...',
 *   // OR use API key:
 *   apiKey: 'clodds_...',
 * });
 *
 * // Execute LLM inference
 * const response = await client.llm({
 *   model: 'claude-sonnet-4-20250514',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 *
 * // Stream LLM response
 * for await (const chunk of client.llmStream({
 *   model: 'gpt-4o',
 *   messages: [{ role: 'user', content: 'Tell me a joke' }],
 * })) {
 *   if (chunk.type === 'text') {
 *     process.stdout.write(chunk.text || '');
 *   }
 * }
 * ```
 */

// =============================================================================
// TYPES
// =============================================================================

export type ComputeService = 'llm' | 'code' | 'web' | 'data' | 'storage' | 'trade';
export type ComputePriority = 'low' | 'normal' | 'high' | 'urgent';
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type LLMModel =
  | 'claude-sonnet-4-20250514'
  | 'claude-3-5-haiku-latest'
  | 'claude-opus-4-20250514'
  | 'gpt-4o'
  | 'gpt-4o-mini'
  | 'llama-3.1-70b'
  | 'llama-3.1-8b'
  | 'mixtral-8x7b';

export interface CloddsClientConfig {
  /** Base URL for the API (default: https://api.clodds.com) */
  baseUrl?: string;
  /** Wallet address (required if not using apiKey) */
  wallet?: string;
  /** API key for authentication (alternative to wallet) */
  apiKey?: string;
  /** Default priority for requests */
  defaultPriority?: ComputePriority;
  /** Request timeout in ms (default: 120000) */
  timeout?: number;
}

export interface WalletBalance {
  wallet: string;
  available: number;
  pending: number;
  totalDeposited: number;
  totalSpent: number;
}

export interface PaymentProof {
  txHash: string;
  network: 'base' | 'ethereum' | 'polygon';
  amountUsd: number;
  token?: string;
  timestamp?: number;
}

export interface CostEstimate {
  service: ComputeService;
  estimatedCost: number;
  breakdown: {
    base: number;
    usage: number;
    subtotal?: number;
    priorityMultiplier?: number;
    total: number;
  };
  units: number;
  unitType: string;
  minCharge: number;
  maxCharge: number;
  priority?: ComputePriority;
}

export interface ComputeResponse {
  id: string;
  jobId: string;
  service: ComputeService;
  status: JobStatus;
  result?: unknown;
  error?: string;
  cost: number;
  timestamp: number;
}

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMRequest {
  model?: LLMModel;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  system?: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  stopReason?: string;
}

export interface LLMStreamChunk {
  type: 'start' | 'text' | 'tool_use' | 'done' | 'error';
  text?: string;
  requestId?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface CodeRequest {
  language: string;
  code: string;
  timeout?: number;
  memoryMB?: number;
}

export interface CodeResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
}

export interface WebRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  followRedirects?: boolean;
  timeout?: number;
}

export interface WebResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
}

export interface SpendingLimits {
  wallet: string;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  dailySpent: number;
  monthlySpent: number;
  dailyRemaining: number | null;
  monthlyRemaining: number | null;
}

export interface ApiKey {
  apiKey: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}

export interface Metrics {
  uptime: number;
  totalRequests: number;
  totalRevenue: number;
  activeJobs: number;
  jobsByStatus: Record<string, number>;
  requestsByService: Record<string, number>;
}

// =============================================================================
// ERROR CLASS
// =============================================================================

export class CloddsError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code?: string
  ) {
    super(message);
    this.name = 'CloddsError';
  }
}

// =============================================================================
// CLIENT
// =============================================================================

export class CloddsClient {
  private baseUrl: string;
  private wallet?: string;
  private apiKey?: string;
  private defaultPriority: ComputePriority;
  private timeout: number;

  constructor(config: CloddsClientConfig = {}) {
    this.baseUrl = (config.baseUrl || 'https://api.clodds.com').replace(/\/$/, '');
    this.wallet = config.wallet?.toLowerCase();
    this.apiKey = config.apiKey;
    this.defaultPriority = config.defaultPriority || 'normal';
    this.timeout = config.timeout || 120000;

    if (!this.wallet && !this.apiKey) {
      throw new Error('Either wallet or apiKey must be provided');
    }
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}/v1${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: this.getHeaders(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new CloddsError(
          data.error || `HTTP ${response.status}`,
          response.status
        );
      }

      return data as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private getWalletOrThrow(): string {
    if (this.wallet) return this.wallet;
    throw new Error('Wallet address required for this operation');
  }

  // ===========================================================================
  // HEALTH & METRICS
  // ===========================================================================

  /** Check API health */
  async health(): Promise<{ status: string; version: string }> {
    return this.request('GET', '/health');
  }

  /** Get service pricing */
  async pricing(): Promise<Record<ComputeService, unknown>> {
    return this.request('GET', '/pricing');
  }

  /** Get API metrics */
  async metrics(): Promise<Metrics> {
    return this.request('GET', '/metrics');
  }

  // ===========================================================================
  // WALLET & BALANCE
  // ===========================================================================

  /** Get wallet balance */
  async getBalance(wallet?: string): Promise<WalletBalance> {
    const w = wallet || this.getWalletOrThrow();
    return this.request('GET', `/balance/${w}`);
  }

  /** Deposit credits with payment proof */
  async deposit(proof: PaymentProof): Promise<{ success: boolean; newBalance: number }> {
    return this.request('POST', '/deposit', {
      wallet: this.getWalletOrThrow(),
      paymentProof: proof,
    });
  }

  // ===========================================================================
  // COST ESTIMATION
  // ===========================================================================

  /** Estimate cost for a request */
  async estimate(
    service: ComputeService,
    payload: unknown,
    priority?: ComputePriority
  ): Promise<CostEstimate> {
    return this.request('POST', '/estimate', {
      service,
      payload,
      priority: priority || this.defaultPriority,
    });
  }

  // ===========================================================================
  // COMPUTE - LLM
  // ===========================================================================

  /** Execute LLM inference */
  async llm(request: LLMRequest, priority?: ComputePriority): Promise<LLMResponse> {
    const response = await this.request<ComputeResponse>('POST', '/compute/llm', {
      wallet: this.wallet,
      payload: request,
      priority: priority || this.defaultPriority,
    });

    if (response.status === 'failed') {
      throw new CloddsError(response.error || 'LLM request failed', 400);
    }

    return response.result as LLMResponse;
  }

  /** Stream LLM inference (async generator) */
  async *llmStream(request: LLMRequest): AsyncGenerator<LLMStreamChunk, void, unknown> {
    const url = `${this.baseUrl}/v1/stream/llm`;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        wallet: this.wallet,
        payload: request,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new CloddsError(error.error || `HTTP ${response.status}`, response.status);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new CloddsError('No response body', 500);
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              yield data as LLMStreamChunk;
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ===========================================================================
  // COMPUTE - CODE
  // ===========================================================================

  /** Execute code in sandbox */
  async code(request: CodeRequest, priority?: ComputePriority): Promise<CodeResponse> {
    const response = await this.request<ComputeResponse>('POST', '/compute/code', {
      wallet: this.wallet,
      payload: request,
      priority: priority || this.defaultPriority,
    });

    if (response.status === 'failed') {
      throw new CloddsError(response.error || 'Code execution failed', 400);
    }

    return response.result as CodeResponse;
  }

  // ===========================================================================
  // COMPUTE - WEB
  // ===========================================================================

  /** Fetch web content */
  async web(request: WebRequest, priority?: ComputePriority): Promise<WebResponse> {
    const response = await this.request<ComputeResponse>('POST', '/compute/web', {
      wallet: this.wallet,
      payload: request,
      priority: priority || this.defaultPriority,
    });

    if (response.status === 'failed') {
      throw new CloddsError(response.error || 'Web request failed', 400);
    }

    return response.result as WebResponse;
  }

  // ===========================================================================
  // COMPUTE - GENERIC
  // ===========================================================================

  /** Submit generic compute request */
  async compute(
    service: ComputeService,
    payload: unknown,
    options?: { priority?: ComputePriority; callbackUrl?: string }
  ): Promise<ComputeResponse> {
    return this.request('POST', `/compute/${service}`, {
      wallet: this.wallet,
      payload,
      priority: options?.priority || this.defaultPriority,
      callbackUrl: options?.callbackUrl,
    });
  }

  /** Submit batch of compute requests */
  async batch(
    requests: Array<{ service: ComputeService; payload: unknown; priority?: ComputePriority }>
  ): Promise<{ batchId: string; total: number; successful: number; failed: number; results: ComputeResponse[] }> {
    return this.request('POST', '/batch', {
      wallet: this.wallet,
      requests: requests.map(r => ({
        service: r.service,
        payload: r.payload,
        priority: r.priority || this.defaultPriority,
      })),
    });
  }

  // ===========================================================================
  // JOBS
  // ===========================================================================

  /** Get job status */
  async getJob(jobId: string): Promise<ComputeResponse | null> {
    try {
      return await this.request('GET', `/job/${jobId}`);
    } catch (e) {
      if (e instanceof CloddsError && e.statusCode === 404) {
        return null;
      }
      throw e;
    }
  }

  /** List jobs for wallet */
  async listJobs(
    wallet?: string,
    limit?: number
  ): Promise<{ jobs: ComputeResponse[]; count: number }> {
    const w = wallet || this.getWalletOrThrow();
    const query = limit ? `?limit=${limit}` : '';
    return this.request('GET', `/jobs/${w}${query}`);
  }

  /** Cancel a job */
  async cancelJob(jobId: string): Promise<boolean> {
    try {
      await this.request('DELETE', `/job/${jobId}`);
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // SPENDING LIMITS
  // ===========================================================================

  /** Get spending limits */
  async getSpendingLimits(wallet?: string): Promise<SpendingLimits> {
    const w = wallet || this.getWalletOrThrow();
    return this.request('GET', `/limits/${w}`);
  }

  /** Set spending limits */
  async setSpendingLimits(
    limits: { dailyLimit?: number | null; monthlyLimit?: number | null },
    wallet?: string
  ): Promise<SpendingLimits> {
    const w = wallet || this.getWalletOrThrow();
    return this.request('POST', `/limits/${w}`, limits);
  }

  // ===========================================================================
  // API KEYS
  // ===========================================================================

  /** Create API key */
  async createApiKey(name?: string): Promise<{ apiKey: string; wallet: string; name: string }> {
    return this.request('POST', '/apikeys', {
      wallet: this.getWalletOrThrow(),
      name: name || 'Default',
    });
  }

  /** List API keys */
  async listApiKeys(wallet?: string): Promise<{ apiKeys: ApiKey[]; count: number }> {
    const w = wallet || this.getWalletOrThrow();
    return this.request('GET', `/apikeys/${w}`);
  }

  /** Revoke API key */
  async revokeApiKey(apiKey: string): Promise<boolean> {
    try {
      await this.request('DELETE', `/apikeys/${this.getWalletOrThrow()}/${apiKey}`);
      return true;
    } catch {
      return false;
    }
  }
}

// =============================================================================
// CONVENIENCE EXPORTS
// =============================================================================

/** Create a new Clodds client */
export function createClient(config: CloddsClientConfig): CloddsClient {
  return new CloddsClient(config);
}

export default CloddsClient;

/**
 * Pump.fun Swarm Trading System
 *
 * Coordinates up to 20 wallets to execute trades simultaneously on Pump.fun tokens.
 *
 * Execution modes:
 * - Parallel: All wallets execute simultaneously (fastest, default for >5 wallets)
 * - Jito Bundle: Atomic execution for up to 5 wallets per bundle
 * - Multi-Bundle: Multiple Jito bundles in parallel for >5 wallets
 * - Sequential: Staggered execution with delays (for stealth)
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  SystemProgram,
  TransactionMessage,
} from '@solana/web3.js';
import { EventEmitter } from 'events';
import bs58 from 'bs58';

// ============================================================================
// Types
// ============================================================================

export interface SwarmWallet {
  id: string;
  keypair: Keypair;
  publicKey: string;
  solBalance: number;
  positions: Map<string, number>;
  lastTradeAt: number;
  enabled: boolean;
}

export interface SwarmConfig {
  rpcUrl: string;
  wallets: SwarmWallet[];
  maxWallets: number;
  rateLimitMs: number;
  bundleEnabled: boolean;
  jitoTipLamports: number;
  defaultSlippageBps: number;
  staggerDelayMs: number;
  amountVariancePct: number;
  minSolBalance: number;
  confirmTimeoutMs: number;
  parallelBatches: number; // How many parallel batches for large swarms
}

export type ExecutionMode = 'parallel' | 'bundle' | 'multi-bundle' | 'sequential';

export interface SwarmTradeParams {
  mint: string;
  action: 'buy' | 'sell';
  amountPerWallet: number | string;
  denominatedInSol?: boolean;
  slippageBps?: number;
  priorityFeeLamports?: number;
  pool?: string;
  executionMode?: ExecutionMode; // User can specify
  walletIds?: string[];
}

export interface SwarmTradeResult {
  success: boolean;
  mint: string;
  action: 'buy' | 'sell';
  walletResults: WalletTradeResult[];
  bundleIds?: string[];
  totalSolSpent?: number;
  totalTokens?: number;
  executionTimeMs: number;
  executionMode: ExecutionMode;
  errors?: string[];
}

export interface WalletTradeResult {
  walletId: string;
  publicKey: string;
  success: boolean;
  signature?: string;
  solAmount?: number;
  tokenAmount?: number;
  error?: string;
}

export interface SwarmPosition {
  mint: string;
  totalTokens: number;
  byWallet: Map<string, number>;
  lastUpdated: number;
}

// ============================================================================
// Constants
// ============================================================================

const PUMPPORTAL_API = 'https://pumpportal.fun/api';
const JITO_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.wtf';
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVmkdzeF3DY3kfvJf3hXba',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

const MAX_BUNDLE_SIZE = 5; // Jito limit
const MAX_WALLETS = 20;

// ============================================================================
// Wallet Pool Management
// ============================================================================

export function loadWalletsFromEnv(): SwarmWallet[] {
  const wallets: SwarmWallet[] = [];

  // Load SOLANA_PRIVATE_KEY as wallet 0
  const mainKey = process.env.SOLANA_PRIVATE_KEY;
  if (mainKey) {
    try {
      const keypair = loadKeypairFromString(mainKey);
      wallets.push(createWallet('wallet_0', keypair));
    } catch (e) {
      console.error('Failed to load SOLANA_PRIVATE_KEY:', e);
    }
  }

  // Load SOLANA_SWARM_KEY_1 through SOLANA_SWARM_KEY_20
  for (let i = 1; i <= MAX_WALLETS; i++) {
    const key = process.env[`SOLANA_SWARM_KEY_${i}`];
    if (!key) continue;

    try {
      const keypair = loadKeypairFromString(key);
      wallets.push(createWallet(`wallet_${i}`, keypair));
    } catch (e) {
      console.error(`Failed to load SOLANA_SWARM_KEY_${i}:`, e);
    }
  }

  return wallets;
}

function createWallet(id: string, keypair: Keypair): SwarmWallet {
  return {
    id,
    keypair,
    publicKey: keypair.publicKey.toBase58(),
    solBalance: 0,
    positions: new Map(),
    lastTradeAt: 0,
    enabled: true,
  };
}

function loadKeypairFromString(keyStr: string): Keypair {
  // Try base58
  try {
    const decoded = bs58.decode(keyStr);
    if (decoded.length === 64) return Keypair.fromSecretKey(decoded);
  } catch {}

  // Try JSON array
  try {
    const arr = JSON.parse(keyStr);
    if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {}

  // Try hex
  try {
    const hex = keyStr.replace(/^0x/, '');
    const bytes = Buffer.from(hex, 'hex');
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  } catch {}

  throw new Error('Invalid key format');
}

// ============================================================================
// PumpFun Swarm Class
// ============================================================================

export class PumpFunSwarm extends EventEmitter {
  private connection: Connection;
  private wallets: Map<string, SwarmWallet>;
  private config: SwarmConfig;

  constructor(config: Partial<SwarmConfig> = {}) {
    super();

    const rpcUrl = config.rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(rpcUrl, 'confirmed');

    const loadedWallets = config.wallets || loadWalletsFromEnv();
    this.wallets = new Map(loadedWallets.map(w => [w.id, w]));

    this.config = {
      rpcUrl,
      wallets: loadedWallets,
      maxWallets: config.maxWallets ?? MAX_WALLETS,
      rateLimitMs: config.rateLimitMs ?? 5000,
      bundleEnabled: config.bundleEnabled ?? true,
      jitoTipLamports: config.jitoTipLamports ?? 10000,
      defaultSlippageBps: config.defaultSlippageBps ?? 500,
      staggerDelayMs: config.staggerDelayMs ?? 200,
      amountVariancePct: config.amountVariancePct ?? 5,
      minSolBalance: config.minSolBalance ?? 0.01,
      confirmTimeoutMs: config.confirmTimeoutMs ?? 60000,
      parallelBatches: config.parallelBatches ?? 4,
    };
  }

  // --------------------------------------------------------------------------
  // Public API - Wallet Management
  // --------------------------------------------------------------------------

  getWallets(): SwarmWallet[] {
    return Array.from(this.wallets.values());
  }

  getWallet(id: string): SwarmWallet | undefined {
    return this.wallets.get(id);
  }

  getEnabledWallets(): SwarmWallet[] {
    return this.getWallets().filter(w => w.enabled);
  }

  enableWallet(id: string): void {
    const wallet = this.wallets.get(id);
    if (wallet) wallet.enabled = true;
  }

  disableWallet(id: string): void {
    const wallet = this.wallets.get(id);
    if (wallet) wallet.enabled = false;
  }

  enableAll(): void {
    for (const wallet of this.wallets.values()) {
      wallet.enabled = true;
    }
  }

  disableAll(): void {
    for (const wallet of this.wallets.values()) {
      wallet.enabled = false;
    }
  }

  getWalletCount(): { total: number; enabled: number } {
    const all = this.getWallets();
    return {
      total: all.length,
      enabled: all.filter(w => w.enabled).length,
    };
  }

  // --------------------------------------------------------------------------
  // Public API - Balance & Position Fetching
  // --------------------------------------------------------------------------

  async refreshBalances(): Promise<Map<string, number>> {
    const balances = new Map<string, number>();
    const wallets = this.getWallets();

    // Fetch all balances in parallel
    const results = await Promise.allSettled(
      wallets.map(async (wallet) => {
        const balance = await this.connection.getBalance(wallet.keypair.publicKey);
        return { id: wallet.id, balance: balance / 1e9 };
      })
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const wallet = wallets[i];
      if (result.status === 'fulfilled') {
        wallet.solBalance = result.value.balance;
        balances.set(wallet.id, result.value.balance);
      } else {
        balances.set(wallet.id, wallet.solBalance);
      }
    }

    return balances;
  }

  async refreshTokenPositions(mint: string): Promise<SwarmPosition> {
    const mintPubkey = new PublicKey(mint);
    const byWallet = new Map<string, number>();
    let totalTokens = 0;
    const wallets = this.getWallets();

    // Fetch all token balances in parallel
    const results = await Promise.allSettled(
      wallets.map(async (wallet) => {
        const balance = await this.getTokenBalance(wallet.keypair.publicKey, mintPubkey);
        return { id: wallet.id, balance };
      })
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const wallet = wallets[i];
      if (result.status === 'fulfilled' && result.value.balance > 0) {
        wallet.positions.set(mint, result.value.balance);
        byWallet.set(wallet.id, result.value.balance);
        totalTokens += result.value.balance;
      } else {
        wallet.positions.delete(mint);
      }
    }

    return { mint, totalTokens, byWallet, lastUpdated: Date.now() };
  }

  private async getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<number> {
    const accounts = await this.connection.getTokenAccountsByOwner(owner, { mint });
    if (accounts.value.length === 0) return 0;

    let total = 0;
    for (const acc of accounts.value) {
      const data = acc.account.data;
      const amount = data.readBigUInt64LE(64);
      total += Number(amount);
    }
    return total;
  }

  getSwarmPosition(mint: string): SwarmPosition {
    const byWallet = new Map<string, number>();
    let totalTokens = 0;

    for (const wallet of this.wallets.values()) {
      const amount = wallet.positions.get(mint) || 0;
      if (amount > 0) {
        byWallet.set(wallet.id, amount);
        totalTokens += amount;
      }
    }

    return { mint, totalTokens, byWallet, lastUpdated: Date.now() };
  }

  // --------------------------------------------------------------------------
  // Coordinated Trading - Main Entry Points
  // --------------------------------------------------------------------------

  async coordinatedBuy(params: SwarmTradeParams): Promise<SwarmTradeResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    // Refresh balances first
    await this.refreshBalances();

    // Select and filter wallets
    let wallets = this.selectWallets(params.walletIds);
    const solNeeded = typeof params.amountPerWallet === 'number'
      ? params.amountPerWallet
      : parseFloat(params.amountPerWallet as string);

    wallets = wallets.filter(w => {
      if (w.solBalance < solNeeded + this.config.minSolBalance) {
        errors.push(`${w.id}: insufficient SOL (${w.solBalance.toFixed(4)})`);
        return false;
      }
      return true;
    });

    if (wallets.length === 0) {
      return this.emptyResult(params, 'buy', startTime, errors, 'No wallets with sufficient balance');
    }

    const mode = this.selectExecutionMode(params, wallets.length);
    return this.executeWithMode(mode, params, wallets, startTime, errors);
  }

  async coordinatedSell(params: SwarmTradeParams): Promise<SwarmTradeResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    // Fetch actual token positions from chain
    await this.refreshTokenPositions(params.mint);

    // Select wallets with positions
    let wallets = this.selectWallets(params.walletIds);
    wallets = wallets.filter(w => {
      const pos = w.positions.get(params.mint) || 0;
      if (pos <= 0) {
        errors.push(`${w.id}: no position`);
        return false;
      }
      return true;
    });

    if (wallets.length === 0) {
      return this.emptyResult(params, 'sell', startTime, errors, 'No wallets with positions');
    }

    const mode = this.selectExecutionMode(params, wallets.length);
    return this.executeWithMode(mode, params, wallets, startTime, errors);
  }

  // --------------------------------------------------------------------------
  // Execution Mode Selection & Dispatch
  // --------------------------------------------------------------------------

  private selectExecutionMode(params: SwarmTradeParams, walletCount: number): ExecutionMode {
    // User specified mode takes priority
    if (params.executionMode) return params.executionMode;

    // Default logic:
    // - 1 wallet: parallel (just one)
    // - 2-5 wallets: bundle (atomic)
    // - 6-20 wallets: multi-bundle (multiple atomic bundles in parallel)
    // - If bundles disabled: parallel

    if (!this.config.bundleEnabled) return 'parallel';
    if (walletCount <= 1) return 'parallel';
    if (walletCount <= MAX_BUNDLE_SIZE) return 'bundle';
    return 'multi-bundle';
  }

  private async executeWithMode(
    mode: ExecutionMode,
    params: SwarmTradeParams,
    wallets: SwarmWallet[],
    startTime: number,
    errors: string[]
  ): Promise<SwarmTradeResult> {
    switch (mode) {
      case 'bundle':
        return this.executeSingleBundle(params, wallets, startTime, errors);
      case 'multi-bundle':
        return this.executeMultiBundles(params, wallets, startTime, errors);
      case 'sequential':
        return this.executeSequential(params, wallets, startTime, errors);
      case 'parallel':
      default:
        return this.executeParallel(params, wallets, startTime, errors);
    }
  }

  // --------------------------------------------------------------------------
  // Execution Mode: PARALLEL (All at once, no bundles)
  // --------------------------------------------------------------------------

  private async executeParallel(
    params: SwarmTradeParams,
    wallets: SwarmWallet[],
    startTime: number,
    errors: string[]
  ): Promise<SwarmTradeResult> {
    // Build all transactions in parallel
    const txPromises = wallets.map(async (wallet) => {
      try {
        const amount = this.calculateAmount(params.amountPerWallet, wallet, params.mint);
        if (amount <= 0) return { wallet, tx: null, amount, error: 'Amount is zero' };
        const tx = await this.buildTransaction(wallet, params, amount);
        return { wallet, tx, amount, error: null };
      } catch (e) {
        return { wallet, tx: null, amount: 0, error: e instanceof Error ? e.message : String(e) };
      }
    });

    const txResults = await Promise.all(txPromises);

    // Sign all transactions
    for (const result of txResults) {
      if (result.tx) {
        result.tx.sign([result.wallet.keypair]);
      }
    }

    // Send all transactions in parallel
    const sendPromises = txResults.map(async (result) => {
      if (!result.tx) {
        return {
          walletId: result.wallet.id,
          publicKey: result.wallet.publicKey,
          success: false,
          error: result.error || 'No transaction',
        } as WalletTradeResult;
      }

      try {
        const signature = await this.connection.sendRawTransaction(result.tx.serialize(), {
          skipPreflight: true,
          maxRetries: 3,
        });
        return {
          walletId: result.wallet.id,
          publicKey: result.wallet.publicKey,
          success: true,
          signature,
          solAmount: params.action === 'buy' ? result.amount : undefined,
          tokenAmount: params.action === 'sell' ? result.amount : undefined,
        } as WalletTradeResult;
      } catch (e) {
        return {
          walletId: result.wallet.id,
          publicKey: result.wallet.publicKey,
          success: false,
          error: e instanceof Error ? e.message : String(e),
        } as WalletTradeResult;
      }
    });

    const walletResults = await Promise.all(sendPromises);

    // Confirm all successful sends in parallel (don't wait for full confirmation to return)
    this.confirmAllAsync(walletResults.filter(r => r.success && r.signature).map(r => r.signature!));

    // Schedule position refresh
    setTimeout(() => this.refreshTokenPositions(params.mint), 5000);

    return this.buildResult(params, walletResults, startTime, errors, 'parallel');
  }

  // --------------------------------------------------------------------------
  // Execution Mode: SINGLE BUNDLE (Atomic, up to 5 wallets)
  // --------------------------------------------------------------------------

  private async executeSingleBundle(
    params: SwarmTradeParams,
    wallets: SwarmWallet[],
    startTime: number,
    errors: string[]
  ): Promise<SwarmTradeResult> {
    const { signedTxs, walletResults, tipWallet } = await this.buildAndSignTransactions(params, wallets, errors);

    if (signedTxs.length === 0) {
      return this.buildResult(params, walletResults, startTime, errors, 'bundle');
    }

    // Add tip transaction
    try {
      const tipTx = await this.buildTipTransaction(tipWallet);
      tipTx.sign([tipWallet.keypair]);
      signedTxs.push(tipTx);
    } catch (e) {
      errors.push(`Tip failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Submit bundle
    try {
      const bundleId = await this.submitJitoBundle(signedTxs);
      // Mark all as successful
      for (const result of walletResults) {
        if (!result.error) result.success = true;
      }
      setTimeout(() => this.refreshTokenPositions(params.mint), 5000);
      return this.buildResult(params, walletResults, startTime, errors, 'bundle', [bundleId]);
    } catch (e) {
      errors.push(`Bundle failed: ${e instanceof Error ? e.message : String(e)}`);
      // Fallback to parallel
      return this.executeParallel(params, wallets, startTime, errors);
    }
  }

  // --------------------------------------------------------------------------
  // Execution Mode: MULTI-BUNDLE (Multiple bundles in parallel for >5 wallets)
  // --------------------------------------------------------------------------

  private async executeMultiBundles(
    params: SwarmTradeParams,
    wallets: SwarmWallet[],
    startTime: number,
    errors: string[]
  ): Promise<SwarmTradeResult> {
    // Split wallets into chunks of MAX_BUNDLE_SIZE
    const chunks = this.chunkArray(wallets, MAX_BUNDLE_SIZE);
    const bundleIds: string[] = [];
    const allWalletResults: WalletTradeResult[] = [];

    // Execute all bundles in parallel
    const bundlePromises = chunks.map(async (chunk, index) => {
      const chunkErrors: string[] = [];
      const { signedTxs, walletResults, tipWallet } = await this.buildAndSignTransactions(params, chunk, chunkErrors);

      if (signedTxs.length === 0) {
        return { walletResults, bundleId: null, errors: chunkErrors };
      }

      // Add tip transaction
      try {
        const tipTx = await this.buildTipTransaction(tipWallet);
        tipTx.sign([tipWallet.keypair]);
        signedTxs.push(tipTx);
      } catch (e) {
        chunkErrors.push(`Chunk ${index} tip failed`);
      }

      // Submit bundle
      try {
        const bundleId = await this.submitJitoBundle(signedTxs);
        for (const result of walletResults) {
          if (!result.error) result.success = true;
        }
        return { walletResults, bundleId, errors: chunkErrors };
      } catch (e) {
        chunkErrors.push(`Chunk ${index} bundle failed: ${e instanceof Error ? e.message : String(e)}`);
        // Try parallel for this chunk
        const parallelResults = await this.executeParallelForChunk(params, chunk);
        return { walletResults: parallelResults, bundleId: null, errors: chunkErrors };
      }
    });

    const results = await Promise.all(bundlePromises);

    for (const result of results) {
      allWalletResults.push(...result.walletResults);
      if (result.bundleId) bundleIds.push(result.bundleId);
      errors.push(...result.errors);
    }

    setTimeout(() => this.refreshTokenPositions(params.mint), 5000);
    return this.buildResult(params, allWalletResults, startTime, errors, 'multi-bundle', bundleIds);
  }

  private async executeParallelForChunk(
    params: SwarmTradeParams,
    wallets: SwarmWallet[]
  ): Promise<WalletTradeResult[]> {
    const results: WalletTradeResult[] = [];

    const promises = wallets.map(async (wallet) => {
      try {
        const amount = this.calculateAmount(params.amountPerWallet, wallet, params.mint);
        if (amount <= 0) {
          return { walletId: wallet.id, publicKey: wallet.publicKey, success: false, error: 'Zero amount' };
        }
        const tx = await this.buildTransaction(wallet, params, amount);
        if (!tx) {
          return { walletId: wallet.id, publicKey: wallet.publicKey, success: false, error: 'Build failed' };
        }
        tx.sign([wallet.keypair]);
        const signature = await this.connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 3,
        });
        return {
          walletId: wallet.id,
          publicKey: wallet.publicKey,
          success: true,
          signature,
          solAmount: params.action === 'buy' ? amount : undefined,
          tokenAmount: params.action === 'sell' ? amount : undefined,
        };
      } catch (e) {
        return {
          walletId: wallet.id,
          publicKey: wallet.publicKey,
          success: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    });

    return Promise.all(promises);
  }

  // --------------------------------------------------------------------------
  // Execution Mode: SEQUENTIAL (Staggered, for stealth)
  // --------------------------------------------------------------------------

  private async executeSequential(
    params: SwarmTradeParams,
    wallets: SwarmWallet[],
    startTime: number,
    errors: string[]
  ): Promise<SwarmTradeResult> {
    const walletResults: WalletTradeResult[] = [];

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];

      // Rate limiting
      const timeSinceLastTrade = Date.now() - wallet.lastTradeAt;
      if (timeSinceLastTrade < this.config.rateLimitMs) {
        await sleep(this.config.rateLimitMs - timeSinceLastTrade);
      }

      // Stagger delay
      if (i > 0) {
        const delay = this.config.staggerDelayMs + Math.random() * this.config.staggerDelayMs;
        await sleep(delay);
      }

      try {
        const amount = this.calculateAmount(params.amountPerWallet, wallet, params.mint);
        if (amount <= 0) {
          walletResults.push({ walletId: wallet.id, publicKey: wallet.publicKey, success: false, error: 'Zero amount' });
          continue;
        }

        const result = await this.executeSingleTrade(wallet, params, amount);
        walletResults.push(result);
        wallet.lastTradeAt = Date.now();
        this.emit('trade', { wallet: wallet.id, ...result });
      } catch (e) {
        errors.push(`${wallet.id}: ${e instanceof Error ? e.message : String(e)}`);
        walletResults.push({
          walletId: wallet.id,
          publicKey: wallet.publicKey,
          success: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    setTimeout(() => this.refreshTokenPositions(params.mint), 5000);
    return this.buildResult(params, walletResults, startTime, errors, 'sequential');
  }

  private async executeSingleTrade(
    wallet: SwarmWallet,
    params: SwarmTradeParams,
    amount: number
  ): Promise<WalletTradeResult> {
    const tx = await this.buildTransaction(wallet, params, amount);
    if (!tx) {
      return { walletId: wallet.id, publicKey: wallet.publicKey, success: false, error: 'Build failed' };
    }

    tx.sign([wallet.keypair]);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    try {
      await this.confirmWithTimeout(signature, this.config.confirmTimeoutMs);
    } catch (e) {
      return {
        walletId: wallet.id,
        publicKey: wallet.publicKey,
        success: false,
        signature,
        error: `Confirm failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    return {
      walletId: wallet.id,
      publicKey: wallet.publicKey,
      success: true,
      signature,
      solAmount: params.action === 'buy' ? amount : undefined,
      tokenAmount: params.action === 'sell' ? amount : undefined,
    };
  }

  // --------------------------------------------------------------------------
  // Transaction Building & Jito
  // --------------------------------------------------------------------------

  private async buildAndSignTransactions(
    params: SwarmTradeParams,
    wallets: SwarmWallet[],
    errors: string[]
  ): Promise<{ signedTxs: VersionedTransaction[]; walletResults: WalletTradeResult[]; tipWallet: SwarmWallet }> {
    const signedTxs: VersionedTransaction[] = [];
    const walletResults: WalletTradeResult[] = [];

    for (const wallet of wallets) {
      try {
        const amount = this.calculateAmount(params.amountPerWallet, wallet, params.mint);
        if (amount <= 0) {
          walletResults.push({ walletId: wallet.id, publicKey: wallet.publicKey, success: false, error: 'Zero amount' });
          continue;
        }

        const tx = await this.buildTransaction(wallet, params, amount);
        if (tx) {
          tx.sign([wallet.keypair]);
          signedTxs.push(tx);
          walletResults.push({
            walletId: wallet.id,
            publicKey: wallet.publicKey,
            success: false,
            solAmount: params.action === 'buy' ? amount : undefined,
            tokenAmount: params.action === 'sell' ? amount : undefined,
          });
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        errors.push(`${wallet.id}: ${errMsg}`);
        walletResults.push({ walletId: wallet.id, publicKey: wallet.publicKey, success: false, error: errMsg });
      }
    }

    return { signedTxs, walletResults, tipWallet: wallets[0] };
  }

  private async buildTransaction(
    wallet: SwarmWallet,
    params: SwarmTradeParams,
    amount: number
  ): Promise<VersionedTransaction | null> {
    const apiKey = process.env.PUMPPORTAL_API_KEY;
    const url = apiKey
      ? `${PUMPPORTAL_API}/trade-local?api-key=${apiKey}`
      : `${PUMPPORTAL_API}/trade-local`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: wallet.publicKey,
        action: params.action,
        mint: params.mint,
        amount: amount,
        denominatedInSol: params.denominatedInSol ?? (params.action === 'buy'),
        slippage: (params.slippageBps ?? this.config.defaultSlippageBps) / 100,
        priorityFee: params.priorityFeeLamports ?? 10000,
        pool: params.pool ?? 'auto',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PumpPortal ${response.status}: ${text.slice(0, 100)}`);
    }

    const txData = await response.arrayBuffer();
    return VersionedTransaction.deserialize(new Uint8Array(txData));
  }

  private async buildTipTransaction(wallet: SwarmWallet): Promise<VersionedTransaction> {
    const tipAccount = new PublicKey(
      JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
    );

    const { blockhash } = await this.connection.getLatestBlockhash();

    const instruction = SystemProgram.transfer({
      fromPubkey: wallet.keypair.publicKey,
      toPubkey: tipAccount,
      lamports: this.config.jitoTipLamports,
    });

    const messageV0 = new TransactionMessage({
      payerKey: wallet.keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [instruction],
    }).compileToV0Message();

    return new VersionedTransaction(messageV0);
  }

  private async submitJitoBundle(transactions: VersionedTransaction[]): Promise<string> {
    const serializedTxs = transactions.map(tx => bs58.encode(tx.serialize()));

    const response = await fetch(`${JITO_BLOCK_ENGINE}/api/v1/bundles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [serializedTxs],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jito ${response.status}: ${text}`);
    }

    const result = await response.json() as { result?: string; error?: { message: string } };
    if (result.error) throw new Error(`Jito: ${result.error.message}`);
    return result.result || 'bundle_submitted';
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private selectWallets(walletIds?: string[]): SwarmWallet[] {
    if (walletIds && walletIds.length > 0) {
      return walletIds
        .map(id => this.wallets.get(id))
        .filter((w): w is SwarmWallet => w !== undefined && w.enabled);
    }
    return this.getEnabledWallets();
  }

  private calculateAmount(baseAmount: number | string, wallet: SwarmWallet, mint: string): number {
    let amount: number;

    if (typeof baseAmount === 'string' && baseAmount.endsWith('%')) {
      const pct = parseFloat(baseAmount) / 100;
      const position = wallet.positions.get(mint) || 0;
      amount = Math.floor(position * pct);
    } else {
      amount = typeof baseAmount === 'string' ? parseFloat(baseAmount) : baseAmount;
    }

    // Apply variance (only for buys)
    if (this.config.amountVariancePct > 0 && !(typeof baseAmount === 'string' && baseAmount.endsWith('%'))) {
      const variance = amount * (this.config.amountVariancePct / 100);
      amount += (Math.random() - 0.5) * 2 * variance;
    }

    return Math.max(0, amount);
  }

  private async confirmWithTimeout(signature: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.connection.getSignatureStatus(signature);
      if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
        if (status.value.err) throw new Error(`TX failed: ${JSON.stringify(status.value.err)}`);
        return;
      }
      await sleep(1000);
    }
    throw new Error('Timeout');
  }

  private confirmAllAsync(signatures: string[]): void {
    // Fire and forget - confirms in background
    for (const sig of signatures) {
      this.confirmWithTimeout(sig, this.config.confirmTimeoutMs).catch(() => {});
    }
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private emptyResult(
    params: SwarmTradeParams,
    action: 'buy' | 'sell',
    startTime: number,
    errors: string[],
    defaultError: string
  ): SwarmTradeResult {
    return {
      success: false,
      mint: params.mint,
      action,
      walletResults: [],
      executionTimeMs: Date.now() - startTime,
      executionMode: 'parallel',
      errors: errors.length > 0 ? errors : [defaultError],
    };
  }

  private buildResult(
    params: SwarmTradeParams,
    walletResults: WalletTradeResult[],
    startTime: number,
    errors: string[],
    mode: ExecutionMode,
    bundleIds?: string[]
  ): SwarmTradeResult {
    const successCount = walletResults.filter(r => r.success).length;
    const totalSol = walletResults
      .filter(r => r.success && r.solAmount)
      .reduce((sum, r) => sum + (r.solAmount || 0), 0);

    return {
      success: successCount > 0,
      mint: params.mint,
      action: params.action,
      walletResults,
      bundleIds: bundleIds && bundleIds.length > 0 ? bundleIds : undefined,
      totalSolSpent: params.action === 'buy' ? totalSol : undefined,
      executionTimeMs: Date.now() - startTime,
      executionMode: mode,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

// ============================================================================
// Utilities
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Factory
// ============================================================================

let swarmInstance: PumpFunSwarm | null = null;

export function getSwarm(config?: Partial<SwarmConfig>): PumpFunSwarm {
  if (!swarmInstance || config) {
    swarmInstance = new PumpFunSwarm(config);
  }
  return swarmInstance;
}

export function createSwarm(config?: Partial<SwarmConfig>): PumpFunSwarm {
  return new PumpFunSwarm(config);
}

export function resetSwarm(): void {
  swarmInstance = null;
}

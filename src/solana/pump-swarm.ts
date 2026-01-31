/**
 * Pump.fun Swarm Trading System
 *
 * Coordinates multiple wallets to execute trades on Pump.fun tokens.
 * Supports atomic execution via Jito bundles or staggered sequential execution.
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  TransactionInstruction,
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
  positions: Map<string, number>; // mint -> token amount (fetched from chain)
  lastTradeAt: number;
  enabled: boolean;
}

export interface SwarmConfig {
  rpcUrl: string;
  wallets: SwarmWallet[];
  maxConcurrentTrades: number;
  rateLimitMs: number;
  bundleEnabled: boolean;
  jitoTipLamports: number;
  defaultSlippageBps: number;
  staggerDelayMs: number;
  amountVariancePct: number;
  minSolBalance: number;
  confirmTimeoutMs: number;
}

export interface SwarmTradeParams {
  mint: string;
  action: 'buy' | 'sell';
  amountPerWallet: number | string; // SOL for buy, tokens or "100%" for sell
  denominatedInSol?: boolean;
  slippageBps?: number;
  priorityFeeLamports?: number;
  pool?: string;
  useBundle?: boolean;
  walletIds?: string[]; // Specific wallets, or all if omitted
}

export interface SwarmTradeResult {
  success: boolean;
  mint: string;
  action: 'buy' | 'sell';
  walletResults: WalletTradeResult[];
  bundleId?: string;
  totalSolSpent?: number;
  totalTokens?: number;
  executionTimeMs: number;
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

// SPL Token Program
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

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
      wallets.push({
        id: 'wallet_0',
        keypair,
        publicKey: keypair.publicKey.toBase58(),
        solBalance: 0,
        positions: new Map(),
        lastTradeAt: 0,
        enabled: true,
      });
    } catch (e) {
      console.error('Failed to load SOLANA_PRIVATE_KEY:', e);
    }
  }

  // Load SOLANA_SWARM_KEY_1, SOLANA_SWARM_KEY_2, etc.
  for (let i = 1; i <= 20; i++) {
    const key = process.env[`SOLANA_SWARM_KEY_${i}`];
    if (!key) continue;

    try {
      const keypair = loadKeypairFromString(key);
      wallets.push({
        id: `wallet_${i}`,
        keypair,
        publicKey: keypair.publicKey.toBase58(),
        solBalance: 0,
        positions: new Map(),
        lastTradeAt: 0,
        enabled: true,
      });
    } catch (e) {
      console.error(`Failed to load SOLANA_SWARM_KEY_${i}:`, e);
    }
  }

  return wallets;
}

function loadKeypairFromString(keyStr: string): Keypair {
  // Try base58
  try {
    const decoded = bs58.decode(keyStr);
    if (decoded.length === 64) {
      return Keypair.fromSecretKey(decoded);
    }
  } catch {}

  // Try JSON array
  try {
    const arr = JSON.parse(keyStr);
    if (Array.isArray(arr)) {
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
  } catch {}

  // Try hex
  try {
    const hex = keyStr.replace(/^0x/, '');
    const bytes = Buffer.from(hex, 'hex');
    if (bytes.length === 64) {
      return Keypair.fromSecretKey(bytes);
    }
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
      maxConcurrentTrades: config.maxConcurrentTrades ?? 5,
      rateLimitMs: config.rateLimitMs ?? 5000,
      bundleEnabled: config.bundleEnabled ?? true,
      jitoTipLamports: config.jitoTipLamports ?? 10000,
      defaultSlippageBps: config.defaultSlippageBps ?? 500,
      staggerDelayMs: config.staggerDelayMs ?? 200,
      amountVariancePct: config.amountVariancePct ?? 5,
      minSolBalance: config.minSolBalance ?? 0.01,
      confirmTimeoutMs: config.confirmTimeoutMs ?? 60000,
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

  getWalletCount(): { total: number; enabled: number } {
    const all = this.getWallets();
    return {
      total: all.length,
      enabled: all.filter(w => w.enabled).length,
    };
  }

  // --------------------------------------------------------------------------
  // Public API - Balance & Position Fetching (FROM CHAIN)
  // --------------------------------------------------------------------------

  async refreshBalances(): Promise<Map<string, number>> {
    const balances = new Map<string, number>();

    await Promise.all(
      this.getWallets().map(async (wallet) => {
        try {
          const balance = await this.connection.getBalance(wallet.keypair.publicKey);
          wallet.solBalance = balance / 1e9;
          balances.set(wallet.id, wallet.solBalance);
        } catch (e) {
          console.error(`Failed to get balance for ${wallet.id}:`, e);
          balances.set(wallet.id, wallet.solBalance);
        }
      })
    );

    return balances;
  }

  async refreshTokenPositions(mint: string): Promise<SwarmPosition> {
    const mintPubkey = new PublicKey(mint);
    const byWallet = new Map<string, number>();
    let totalTokens = 0;

    await Promise.all(
      this.getWallets().map(async (wallet) => {
        try {
          const balance = await this.getTokenBalance(wallet.keypair.publicKey, mintPubkey);
          if (balance > 0) {
            wallet.positions.set(mint, balance);
            byWallet.set(wallet.id, balance);
            totalTokens += balance;
          } else {
            wallet.positions.delete(mint);
          }
        } catch (e) {
          // Token account may not exist
          wallet.positions.delete(mint);
        }
      })
    );

    return { mint, totalTokens, byWallet, lastUpdated: Date.now() };
  }

  private async getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<number> {
    const accounts = await this.connection.getTokenAccountsByOwner(owner, { mint });
    if (accounts.value.length === 0) return 0;

    let total = 0;
    for (const acc of accounts.value) {
      const data = acc.account.data;
      // Token account data: first 32 bytes = mint, next 32 = owner, next 8 = amount (u64 LE)
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
  // Coordinated Trading
  // --------------------------------------------------------------------------

  async coordinatedBuy(params: SwarmTradeParams): Promise<SwarmTradeResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    // Refresh balances first
    await this.refreshBalances();

    // Select wallets with sufficient balance
    let wallets = this.selectWallets(params.walletIds);
    const solNeeded = typeof params.amountPerWallet === 'number'
      ? params.amountPerWallet
      : parseFloat(params.amountPerWallet as string);

    wallets = wallets.filter(w => {
      if (w.solBalance < solNeeded + this.config.minSolBalance) {
        errors.push(`${w.id}: insufficient SOL (${w.solBalance.toFixed(4)} < ${solNeeded.toFixed(4)})`);
        return false;
      }
      return true;
    });

    if (wallets.length === 0) {
      return {
        success: false,
        mint: params.mint,
        action: 'buy',
        walletResults: [],
        executionTimeMs: Date.now() - startTime,
        errors: errors.length > 0 ? errors : ['No wallets with sufficient balance'],
      };
    }

    const useBundle = params.useBundle ?? (this.config.bundleEnabled && wallets.length > 1);

    if (useBundle && wallets.length > 1 && wallets.length <= 5) {
      return this.executeBundledTrade(params, wallets, startTime, errors);
    } else {
      return this.executeStaggeredTrade(params, wallets, startTime, errors);
    }
  }

  async coordinatedSell(params: SwarmTradeParams): Promise<SwarmTradeResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    // CRITICAL: Refresh actual token positions from chain
    await this.refreshTokenPositions(params.mint);

    // Select wallets with actual positions
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
      return {
        success: false,
        mint: params.mint,
        action: 'sell',
        walletResults: [],
        executionTimeMs: Date.now() - startTime,
        errors: errors.length > 0 ? errors : ['No wallets have positions in this token'],
      };
    }

    const useBundle = params.useBundle ?? (this.config.bundleEnabled && wallets.length > 1);

    if (useBundle && wallets.length > 1 && wallets.length <= 5) {
      return this.executeBundledTrade(params, wallets, startTime, errors);
    } else {
      return this.executeStaggeredTrade(params, wallets, startTime, errors);
    }
  }

  // --------------------------------------------------------------------------
  // Bundle Execution (Atomic via Jito)
  // --------------------------------------------------------------------------

  private async executeBundledTrade(
    params: SwarmTradeParams,
    wallets: SwarmWallet[],
    startTime: number,
    errors: string[]
  ): Promise<SwarmTradeResult> {
    const walletResults: WalletTradeResult[] = [];
    const signedTransactions: VersionedTransaction[] = [];

    // Build and sign transactions for each wallet
    for (const wallet of wallets) {
      try {
        const amount = this.calculateAmount(params.amountPerWallet, wallet, params.mint);
        if (amount <= 0) {
          walletResults.push({
            walletId: wallet.id,
            publicKey: wallet.publicKey,
            success: false,
            error: 'Amount is zero',
          });
          continue;
        }

        const tx = await this.buildTransaction(wallet, params, amount);
        if (tx) {
          // CRITICAL: Sign transaction before adding to bundle
          tx.sign([wallet.keypair]);
          signedTransactions.push(tx);
          walletResults.push({
            walletId: wallet.id,
            publicKey: wallet.publicKey,
            success: false, // Will update after submission
            solAmount: params.action === 'buy' ? amount : undefined,
            tokenAmount: params.action === 'sell' ? amount : undefined,
          });
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        errors.push(`${wallet.id}: ${errMsg}`);
        walletResults.push({
          walletId: wallet.id,
          publicKey: wallet.publicKey,
          success: false,
          error: errMsg,
        });
      }
    }

    if (signedTransactions.length === 0) {
      return {
        success: false,
        mint: params.mint,
        action: params.action,
        walletResults,
        executionTimeMs: Date.now() - startTime,
        errors,
      };
    }

    // Add tip transaction from first wallet
    try {
      const tipTx = await this.buildTipTransaction(wallets[0]);
      tipTx.sign([wallets[0].keypair]);
      signedTransactions.push(tipTx);
    } catch (e) {
      errors.push(`Tip tx failed: ${e instanceof Error ? e.message : String(e)}`);
      // Continue without tip - Jito may still accept
    }

    // Submit via Jito bundle
    try {
      const bundleId = await this.submitJitoBundle(signedTransactions);

      // Mark all as successful (bundle is atomic)
      for (const result of walletResults) {
        if (!result.error) {
          result.success = true;
        }
      }

      // Refresh positions after trade
      setTimeout(() => this.refreshTokenPositions(params.mint), 5000);

      const totalSol = walletResults
        .filter(r => r.success && r.solAmount)
        .reduce((sum, r) => sum + (r.solAmount || 0), 0);

      return {
        success: true,
        mint: params.mint,
        action: params.action,
        walletResults,
        bundleId,
        totalSolSpent: params.action === 'buy' ? totalSol : undefined,
        executionTimeMs: Date.now() - startTime,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (bundleError) {
      const errMsg = bundleError instanceof Error ? bundleError.message : String(bundleError);
      errors.push(`Bundle failed: ${errMsg}`);

      // Fallback to staggered execution
      console.warn('Bundle submission failed, falling back to staggered:', errMsg);
      return this.executeStaggeredTrade(params, wallets, startTime, errors);
    }
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
    const serializedTxs = transactions.map(tx =>
      bs58.encode(tx.serialize())
    );

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
      throw new Error(`Jito API error ${response.status}: ${text}`);
    }

    const result = await response.json() as { result?: string; error?: { message: string } };

    if (result.error) {
      throw new Error(`Jito error: ${result.error.message}`);
    }

    return result.result || 'bundle_submitted';
  }

  // --------------------------------------------------------------------------
  // Staggered Execution (Sequential with delays)
  // --------------------------------------------------------------------------

  private async executeStaggeredTrade(
    params: SwarmTradeParams,
    wallets: SwarmWallet[],
    startTime: number,
    errors: string[]
  ): Promise<SwarmTradeResult> {
    const walletResults: WalletTradeResult[] = [];

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];

      // Rate limiting per wallet
      const timeSinceLastTrade = Date.now() - wallet.lastTradeAt;
      if (timeSinceLastTrade < this.config.rateLimitMs) {
        await sleep(this.config.rateLimitMs - timeSinceLastTrade);
      }

      // Stagger delay between wallets (randomized)
      if (i > 0) {
        const delay = this.config.staggerDelayMs + Math.random() * this.config.staggerDelayMs;
        await sleep(delay);
      }

      try {
        const amount = this.calculateAmount(params.amountPerWallet, wallet, params.mint);
        if (amount <= 0) {
          walletResults.push({
            walletId: wallet.id,
            publicKey: wallet.publicKey,
            success: false,
            error: 'Amount is zero',
          });
          continue;
        }

        const result = await this.executeSingleTrade(wallet, params, amount);
        walletResults.push(result);

        wallet.lastTradeAt = Date.now();

        // Emit event for monitoring
        this.emit('trade', { wallet: wallet.id, ...result });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        errors.push(`${wallet.id}: ${errMsg}`);
        walletResults.push({
          walletId: wallet.id,
          publicKey: wallet.publicKey,
          success: false,
          error: errMsg,
        });
      }
    }

    // Refresh positions after all trades
    setTimeout(() => this.refreshTokenPositions(params.mint), 5000);

    const successCount = walletResults.filter(r => r.success).length;
    const totalSol = walletResults
      .filter(r => r.success && r.solAmount)
      .reduce((sum, r) => sum + (r.solAmount || 0), 0);

    return {
      success: successCount > 0,
      mint: params.mint,
      action: params.action,
      walletResults,
      totalSolSpent: params.action === 'buy' ? totalSol : undefined,
      executionTimeMs: Date.now() - startTime,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  private async executeSingleTrade(
    wallet: SwarmWallet,
    params: SwarmTradeParams,
    amount: number
  ): Promise<WalletTradeResult> {
    const tx = await this.buildTransaction(wallet, params, amount);
    if (!tx) {
      return {
        walletId: wallet.id,
        publicKey: wallet.publicKey,
        success: false,
        error: 'Failed to build transaction',
      };
    }

    // Sign
    tx.sign([wallet.keypair]);

    // Send with skip preflight for speed
    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    // Confirm with timeout
    try {
      await this.confirmWithTimeout(signature, this.config.confirmTimeoutMs);
    } catch (e) {
      return {
        walletId: wallet.id,
        publicKey: wallet.publicKey,
        success: false,
        signature,
        error: `Confirmation failed: ${e instanceof Error ? e.message : String(e)}`,
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

  private async confirmWithTimeout(signature: string, timeoutMs: number): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const status = await this.connection.getSignatureStatus(signature);

      if (status.value?.confirmationStatus === 'confirmed' ||
          status.value?.confirmationStatus === 'finalized') {
        if (status.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
        }
        return;
      }

      await sleep(1000);
    }

    throw new Error('Confirmation timeout');
  }

  // --------------------------------------------------------------------------
  // Transaction Building
  // --------------------------------------------------------------------------

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
      throw new Error(`PumpPortal error ${response.status}: ${text.slice(0, 200)}`);
    }

    const txData = await response.arrayBuffer();
    return VersionedTransaction.deserialize(new Uint8Array(txData));
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

  private calculateAmount(
    baseAmount: number | string,
    wallet: SwarmWallet,
    mint: string
  ): number {
    let amount: number;

    if (typeof baseAmount === 'string' && baseAmount.endsWith('%')) {
      // Percentage of position (for sells)
      const pct = parseFloat(baseAmount) / 100;
      const position = wallet.positions.get(mint) || 0;
      amount = Math.floor(position * pct); // Floor to avoid rounding issues
    } else {
      amount = typeof baseAmount === 'string' ? parseFloat(baseAmount) : baseAmount;
    }

    // Apply variance (only for buys, not percentage sells)
    if (this.config.amountVariancePct > 0 && !(typeof baseAmount === 'string' && baseAmount.endsWith('%'))) {
      const variance = amount * (this.config.amountVariancePct / 100);
      amount += (Math.random() - 0.5) * 2 * variance;
    }

    return Math.max(0, amount);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Factory Function
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

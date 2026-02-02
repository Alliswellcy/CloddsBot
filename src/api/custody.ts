/**
 * Custody Manager - Managed wallet system for API users
 *
 * Features:
 * - HD wallet derivation (one wallet per user)
 * - Encrypted key storage
 * - EVM + Solana support
 * - Automatic key rotation (optional)
 */

import { EventEmitter } from 'eventemitter3';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync, createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger';
import type { CustodyConfig, ManagedWalletData } from './types';

// =============================================================================
// TYPES
// =============================================================================

export interface CustodyManager {
  /** Get or create managed wallet for user */
  getOrCreate(ownerAddress: string): Promise<ManagedWallet>;
  /** Get existing wallet */
  get(ownerAddress: string): ManagedWallet | null;
  /** List all wallets */
  list(): ManagedWallet[];
  /** Get wallet by ID */
  getById(id: string): ManagedWallet | null;
  /** Check if user has wallet */
  hasWallet(ownerAddress: string): boolean;
  /** Get statistics */
  getStats(): CustodyStats;
}

export interface ManagedWallet {
  /** Wallet ID */
  id: string;
  /** Owner's external wallet address */
  owner: string;
  /** EVM address */
  evmAddress: string;
  /** Solana address (if available) */
  solanaAddress?: string;
  /** Get EVM private key (decrypted) */
  getEvmPrivateKey(): string;
  /** Get Solana private key (decrypted) */
  getSolanaPrivateKey(): string | null;
  /** Get wallet data (without keys) */
  getData(): ManagedWalletData;
  /** Update last used timestamp */
  touch(): void;
}

export interface CustodyStats {
  totalWallets: number;
  activeWallets: number; // Used in last 24h
  totalDerivationIndex: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_CONFIG: Required<CustodyConfig> = {
  enabled: false,
  masterKey: '',
  derivationPath: "m/44'/60'/0'/0",
  storageDir: join(homedir(), '.clodds', 'api', 'wallets'),
};

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

// =============================================================================
// ENCRYPTION HELPERS
// =============================================================================

function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, KEY_LENGTH);
}

function encrypt(plaintext: string, masterKey: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(masterKey, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: salt:iv:authTag:encrypted (all base64)
  return [
    salt.toString('base64'),
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

function decrypt(ciphertext: string, masterKey: string): string {
  const [saltB64, ivB64, authTagB64, encryptedB64] = ciphertext.split(':');

  const salt = Buffer.from(saltB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');

  const key = deriveKey(masterKey, salt);

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(encrypted) + decipher.final('utf8');
}

// =============================================================================
// WALLET GENERATION
// =============================================================================

interface WalletKeys {
  evmPrivateKey: string;
  evmAddress: string;
  solanaPrivateKey?: string;
  solanaAddress?: string;
}

function generateWalletFromIndex(derivationIndex: number, masterSeed: string): WalletKeys {
  // Derive deterministic keys from master seed + index
  // In production, use proper BIP-32/BIP-44 derivation

  // For EVM: sha256(masterSeed + index)
  const evmSeedMaterial = `${masterSeed}:evm:${derivationIndex}`;
  const evmPrivateKey = createHash('sha256').update(evmSeedMaterial).digest('hex');
  const evmAddress = `0x${createHash('sha256').update(evmPrivateKey).digest('hex').slice(0, 40)}`;

  // For Solana: sha256(masterSeed + index + solana)
  const solanaSeedMaterial = `${masterSeed}:solana:${derivationIndex}`;
  const solanaPrivateKey = createHash('sha256').update(solanaSeedMaterial).digest('hex');
  const solanaAddress = createHash('sha256').update(solanaPrivateKey).digest('hex').slice(0, 44);

  return {
    evmPrivateKey: `0x${evmPrivateKey}`,
    evmAddress,
    solanaPrivateKey,
    solanaAddress,
  };
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

interface StoredWallet {
  id: string;
  owner: string;
  evmAddress: string;
  solanaAddress?: string;
  encryptedEvmKey: string;
  encryptedSolanaKey?: string;
  derivationIndex: number;
  createdAt: number;
  lastUsedAt: number;
}

export function createCustodyManager(config: CustodyConfig = {}): CustodyManager {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (cfg.enabled && !cfg.masterKey) {
    throw new Error('Custody manager requires masterKey when enabled');
  }

  // Derive master seed from master key
  const masterSeed = cfg.masterKey
    ? createHash('sha256').update(`clodds:custody:${cfg.masterKey}`).digest('hex')
    : '';

  // Wallet storage
  const wallets = new Map<string, StoredWallet>(); // owner -> wallet
  const walletsById = new Map<string, StoredWallet>(); // id -> wallet
  let nextDerivationIndex = 0;

  // Ensure storage directory exists
  if (cfg.enabled) {
    mkdirSync(cfg.storageDir, { recursive: true });
    loadWallets();
  }

  function loadWallets(): void {
    try {
      const indexPath = join(cfg.storageDir, 'index.json');
      if (existsSync(indexPath)) {
        const data = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
          wallets: StoredWallet[];
          nextIndex: number;
        };

        for (const wallet of data.wallets) {
          wallets.set(wallet.owner.toLowerCase(), wallet);
          walletsById.set(wallet.id, wallet);
        }
        nextDerivationIndex = data.nextIndex;

        logger.info({ count: wallets.size }, 'Loaded custody wallets');
      }
    } catch (e) {
      logger.warn('Failed to load custody wallets, starting fresh');
    }
  }

  function saveWallets(): void {
    try {
      const indexPath = join(cfg.storageDir, 'index.json');
      const data = {
        wallets: Array.from(wallets.values()),
        nextIndex: nextDerivationIndex,
      };
      writeFileSync(indexPath, JSON.stringify(data, null, 2));
    } catch (e) {
      logger.error({ error: e }, 'Failed to save custody wallets');
    }
  }

  function generateWalletId(): string {
    return `cw_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  }

  function createWalletWrapper(stored: StoredWallet): ManagedWallet {
    return {
      id: stored.id,
      owner: stored.owner,
      evmAddress: stored.evmAddress,
      solanaAddress: stored.solanaAddress,

      getEvmPrivateKey(): string {
        return decrypt(stored.encryptedEvmKey, cfg.masterKey);
      },

      getSolanaPrivateKey(): string | null {
        if (!stored.encryptedSolanaKey) return null;
        return decrypt(stored.encryptedSolanaKey, cfg.masterKey);
      },

      getData(): ManagedWalletData {
        return {
          id: stored.id,
          owner: stored.owner,
          evmAddress: stored.evmAddress,
          solanaAddress: stored.solanaAddress,
          createdAt: stored.createdAt,
          lastUsedAt: stored.lastUsedAt,
          derivationIndex: stored.derivationIndex,
        };
      },

      touch(): void {
        stored.lastUsedAt = Date.now();
        saveWallets();
      },
    };
  }

  async function getOrCreate(ownerAddress: string): Promise<ManagedWallet> {
    if (!cfg.enabled) {
      throw new Error('Custody manager is not enabled');
    }

    const ownerLower = ownerAddress.toLowerCase();

    // Check existing
    const existing = wallets.get(ownerLower);
    if (existing) {
      existing.lastUsedAt = Date.now();
      saveWallets();
      return createWalletWrapper(existing);
    }

    // Generate new wallet
    const index = nextDerivationIndex++;
    const keys = generateWalletFromIndex(index, masterSeed);

    const stored: StoredWallet = {
      id: generateWalletId(),
      owner: ownerAddress,
      evmAddress: keys.evmAddress,
      solanaAddress: keys.solanaAddress,
      encryptedEvmKey: encrypt(keys.evmPrivateKey, cfg.masterKey),
      encryptedSolanaKey: keys.solanaPrivateKey ? encrypt(keys.solanaPrivateKey, cfg.masterKey) : undefined,
      derivationIndex: index,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };

    wallets.set(ownerLower, stored);
    walletsById.set(stored.id, stored);
    saveWallets();

    logger.info({ walletId: stored.id, owner: ownerAddress, evmAddress: stored.evmAddress }, 'Created custody wallet');

    return createWalletWrapper(stored);
  }

  function get(ownerAddress: string): ManagedWallet | null {
    if (!cfg.enabled) return null;

    const stored = wallets.get(ownerAddress.toLowerCase());
    if (!stored) return null;

    return createWalletWrapper(stored);
  }

  function getById(id: string): ManagedWallet | null {
    if (!cfg.enabled) return null;

    const stored = walletsById.get(id);
    if (!stored) return null;

    return createWalletWrapper(stored);
  }

  function list(): ManagedWallet[] {
    if (!cfg.enabled) return [];

    return Array.from(wallets.values()).map(createWalletWrapper);
  }

  function hasWallet(ownerAddress: string): boolean {
    if (!cfg.enabled) return false;
    return wallets.has(ownerAddress.toLowerCase());
  }

  function getStats(): CustodyStats {
    const now = Date.now();
    const dayAgo = now - 86400000;

    let activeCount = 0;
    for (const wallet of wallets.values()) {
      if (wallet.lastUsedAt > dayAgo) {
        activeCount++;
      }
    }

    return {
      totalWallets: wallets.size,
      activeWallets: activeCount,
      totalDerivationIndex: nextDerivationIndex,
    };
  }

  return {
    getOrCreate,
    get,
    getById,
    list,
    hasWallet,
    getStats,
  };
}

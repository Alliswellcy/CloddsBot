/**
 * x402 Solana Payment Signing
 *
 * Uses Ed25519 signing for Solana payments
 */

import { createHash, randomBytes } from 'crypto';
import { logger } from '../../utils/logger';
import type { X402PaymentOption, X402PaymentPayload } from './index';

// =============================================================================
// TYPES
// =============================================================================

export interface SolanaWallet {
  publicKey: string;
  secretKey: Uint8Array;
}

// =============================================================================
// WALLET UTILITIES
// =============================================================================

/**
 * Decode base58 string to bytes
 */
function base58Decode(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i++) {
    ALPHABET_MAP.set(ALPHABET[i], i);
  }

  const bytes: number[] = [0];
  for (const char of str) {
    const value = ALPHABET_MAP.get(char);
    if (value === undefined) throw new Error(`Invalid base58 character: ${char}`);

    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Handle leading zeros
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}

/**
 * Encode bytes to base58 string
 */
function base58Encode(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  // Handle leading zeros
  let str = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    str += '1';
  }

  for (let i = digits.length - 1; i >= 0; i--) {
    str += ALPHABET[digits[i]];
  }

  return str;
}

/**
 * Create a Solana wallet from secret key
 */
export function createSolanaWallet(secretKeyOrBase58: string | Uint8Array): SolanaWallet {
  let secretKey: Uint8Array;

  if (typeof secretKeyOrBase58 === 'string') {
    // Try base58 first, then raw hex
    if (secretKeyOrBase58.length === 88 || secretKeyOrBase58.length === 87) {
      secretKey = base58Decode(secretKeyOrBase58);
    } else if (secretKeyOrBase58.length === 128) {
      secretKey = new Uint8Array(Buffer.from(secretKeyOrBase58, 'hex'));
    } else {
      // JSON array format
      try {
        const arr = JSON.parse(secretKeyOrBase58);
        secretKey = new Uint8Array(arr);
      } catch {
        throw new Error('Invalid Solana secret key format');
      }
    }
  } else {
    secretKey = secretKeyOrBase58;
  }

  // Public key is the last 32 bytes (or derived from first 32)
  const publicKey = secretKey.length === 64
    ? base58Encode(secretKey.slice(32))
    : base58Encode(secretKey.slice(0, 32)); // Simplified

  return {
    publicKey,
    secretKey,
  };
}

// =============================================================================
// ED25519 SIGNING (SIMPLIFIED)
// =============================================================================

/**
 * Sign a message with Ed25519
 * Simplified implementation - use @solana/web3.js in production
 */
function signEd25519(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  // In production, use:
  // import { sign } from '@noble/ed25519'
  // return sign(message, secretKey.slice(0, 32))

  // Placeholder using HMAC (NOT SECURE - replace with Ed25519)
  const hmac = createHash('sha512')
    .update(Buffer.concat([secretKey.slice(0, 32), message]))
    .digest();

  return new Uint8Array(hmac.slice(0, 64));
}

// =============================================================================
// PAYMENT SIGNING
// =============================================================================

/**
 * Sign an x402 payment for Solana
 */
export async function signSolanaPayment(
  wallet: SolanaWallet,
  option: X402PaymentOption
): Promise<X402PaymentPayload> {
  const nonce = randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000);

  // Create message to sign
  const message = JSON.stringify({
    scheme: option.scheme,
    network: option.network,
    asset: option.asset,
    amount: option.maxAmountRequired,
    payTo: option.payTo,
    nonce,
    timestamp,
    validUntil: option.validUntil || timestamp + 300,
  });

  const messageBytes = new TextEncoder().encode(message);
  const messageHash = createHash('sha256').update(messageBytes).digest();

  // Sign the hash
  const signatureBytes = signEd25519(new Uint8Array(messageHash), wallet.secretKey);
  const signature = base58Encode(signatureBytes);

  logger.debug(
    { network: option.network, amount: option.maxAmountRequired, payer: wallet.publicKey },
    'x402: Signed Solana payment'
  );

  return {
    paymentOption: option,
    signature,
    payer: wallet.publicKey,
    nonce,
    timestamp,
  };
}

/**
 * Verify a Solana payment signature
 */
export function verifySolanaPayment(payload: X402PaymentPayload): boolean {
  // In production, use ed25519.verify()
  // For now, just check format
  return (
    payload.signature.length >= 64 &&
    payload.payer.length >= 32
  );
}

// =============================================================================
// SPL TOKEN UTILITIES
// =============================================================================

/**
 * Get associated token address for USDC
 */
export function getAssociatedTokenAddress(
  walletAddress: string,
  mintAddress: string
): string {
  // In production, use @solana/spl-token
  // This is a placeholder
  const combined = walletAddress + mintAddress;
  const hash = createHash('sha256').update(combined).digest();
  return base58Encode(new Uint8Array(hash.slice(0, 32)));
}

// =============================================================================
// EXPORTS
// =============================================================================

export { base58Encode, base58Decode };

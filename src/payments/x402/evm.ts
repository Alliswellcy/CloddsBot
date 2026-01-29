/**
 * x402 EVM (Base) Payment Signing
 *
 * Uses EIP-712 typed data signing for secure payments
 */

import { createHash, createHmac, randomBytes } from 'crypto';
import { logger } from '../../utils/logger';
import type { X402PaymentOption, X402PaymentPayload, X402Network } from './index';

// =============================================================================
// TYPES
// =============================================================================

export interface EvmWallet {
  address: string;
  privateKey: string;
}

export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

export interface X402PaymentMessage {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  nonce: string;
  validUntil: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const CHAIN_IDS: Record<X402Network, number> = {
  'base': 8453,
  'base-sepolia': 84532,
  'solana': 0,
  'solana-devnet': 0,
};

const X402_DOMAIN: Omit<EIP712Domain, 'chainId'> = {
  name: 'x402',
  version: '1',
  verifyingContract: '0x0000000000000000000000000000000000000402',
};

const PAYMENT_TYPES = {
  Payment: [
    { name: 'scheme', type: 'string' },
    { name: 'network', type: 'string' },
    { name: 'asset', type: 'string' },
    { name: 'amount', type: 'uint256' },
    { name: 'payTo', type: 'address' },
    { name: 'nonce', type: 'string' },
    { name: 'validUntil', type: 'uint256' },
  ],
};

// =============================================================================
// WALLET UTILITIES
// =============================================================================

/**
 * Derive Ethereum address from private key
 * Simplified implementation - use ethers.js or viem in production
 */
export function deriveEvmAddress(privateKey: string): string {
  // Remove 0x prefix if present
  const keyBytes = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;

  // This is a placeholder - in production use:
  // import { privateKeyToAccount } from 'viem/accounts'
  // return privateKeyToAccount(`0x${keyBytes}`).address

  // For now, create deterministic address from key hash
  const hash = createHash('keccak256').update(Buffer.from(keyBytes, 'hex')).digest('hex');
  return '0x' + hash.slice(24);
}

/**
 * Create an EVM wallet from private key
 */
export function createEvmWallet(privateKey: string): EvmWallet {
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  return {
    address: deriveEvmAddress(key),
    privateKey: key,
  };
}

// =============================================================================
// EIP-712 SIGNING
// =============================================================================

/**
 * Hash EIP-712 domain separator
 */
function hashDomain(domain: EIP712Domain): string {
  const typeHash = createHash('keccak256')
    .update('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')
    .digest();

  const nameHash = createHash('keccak256').update(domain.name).digest();
  const versionHash = createHash('keccak256').update(domain.version).digest();
  const chainIdHex = domain.chainId.toString(16).padStart(64, '0');
  const contractHex = domain.verifyingContract.slice(2).padStart(64, '0');

  const encoded = Buffer.concat([
    typeHash,
    nameHash,
    versionHash,
    Buffer.from(chainIdHex, 'hex'),
    Buffer.from(contractHex, 'hex'),
  ]);

  return '0x' + createHash('keccak256').update(encoded).digest('hex');
}

/**
 * Hash EIP-712 struct data
 */
function hashStruct(message: X402PaymentMessage): string {
  const typeHash = createHash('keccak256')
    .update('Payment(string scheme,string network,string asset,uint256 amount,address payTo,string nonce,uint256 validUntil)')
    .digest();

  const schemeHash = createHash('keccak256').update(message.scheme).digest();
  const networkHash = createHash('keccak256').update(message.network).digest();
  const assetHash = createHash('keccak256').update(message.asset).digest();
  const amountHex = BigInt(message.amount).toString(16).padStart(64, '0');
  const payToHex = message.payTo.slice(2).padStart(64, '0');
  const nonceHash = createHash('keccak256').update(message.nonce).digest();
  const validUntilHex = message.validUntil.toString(16).padStart(64, '0');

  const encoded = Buffer.concat([
    typeHash,
    schemeHash,
    networkHash,
    assetHash,
    Buffer.from(amountHex, 'hex'),
    Buffer.from(payToHex, 'hex'),
    nonceHash,
    Buffer.from(validUntilHex, 'hex'),
  ]);

  return '0x' + createHash('keccak256').update(encoded).digest('hex');
}

/**
 * Create EIP-712 typed data hash
 */
function createTypedDataHash(domain: EIP712Domain, message: X402PaymentMessage): string {
  const domainSeparator = hashDomain(domain);
  const structHash = hashStruct(message);

  const encoded = Buffer.concat([
    Buffer.from([0x19, 0x01]),
    Buffer.from(domainSeparator.slice(2), 'hex'),
    Buffer.from(structHash.slice(2), 'hex'),
  ]);

  return '0x' + createHash('keccak256').update(encoded).digest('hex');
}

/**
 * Sign a message with ECDSA
 * Simplified - use ethers.js or viem in production
 */
function signMessage(messageHash: string, privateKey: string): string {
  // In production, use proper ECDSA signing:
  // import { signTypedData } from 'viem/accounts'
  // return signTypedData({ privateKey, domain, types, message })

  // Placeholder using HMAC (NOT SECURE - replace with ECDSA)
  const keyBytes = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  const sig = createHmac('sha256', Buffer.from(keyBytes, 'hex'))
    .update(Buffer.from(messageHash.slice(2), 'hex'))
    .digest('hex');

  // Pad to 65 bytes (r, s, v)
  return '0x' + sig.padEnd(128, '0') + '1b'; // v = 27
}

// =============================================================================
// PAYMENT SIGNING
// =============================================================================

/**
 * Sign an x402 payment for EVM networks (Base)
 */
export async function signEvmPayment(
  wallet: EvmWallet,
  option: X402PaymentOption
): Promise<X402PaymentPayload> {
  const nonce = randomBytes(16).toString('hex');
  const validUntil = option.validUntil || Math.floor(Date.now() / 1000) + 300;

  const chainId = CHAIN_IDS[option.network] || 8453;

  const domain: EIP712Domain = {
    ...X402_DOMAIN,
    chainId,
  };

  const message: X402PaymentMessage = {
    scheme: option.scheme,
    network: option.network,
    asset: option.asset,
    amount: option.maxAmountRequired,
    payTo: option.payTo,
    nonce,
    validUntil,
  };

  const hash = createTypedDataHash(domain, message);
  const signature = signMessage(hash, wallet.privateKey);

  logger.debug(
    { network: option.network, amount: option.maxAmountRequired, payer: wallet.address },
    'x402: Signed EVM payment'
  );

  return {
    paymentOption: option,
    signature,
    payer: wallet.address,
    nonce,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

/**
 * Verify an EVM payment signature
 */
export function verifyEvmPayment(payload: X402PaymentPayload): boolean {
  // In production, use ecrecover to verify
  // For now, just check signature format
  return (
    payload.signature.startsWith('0x') &&
    payload.signature.length >= 130 &&
    payload.payer.startsWith('0x')
  );
}

// =============================================================================
// EXPORTS
// =============================================================================

export { CHAIN_IDS, X402_DOMAIN, PAYMENT_TYPES };

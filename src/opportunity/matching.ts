/**
 * Market Matching - Semantic and text-based market matching across platforms
 *
 * Features:
 * - Embedding-based semantic similarity
 * - Text normalization and token matching
 * - Manual link overrides
 * - Caching for performance
 * - Configurable similarity thresholds
 */

import type { Database } from '../db/index';
import type { EmbeddingsService } from '../embeddings/index';
import type { Platform, Market } from '../types';
import { logger } from '../utils/logger';

// =============================================================================
// TYPES
// =============================================================================

export interface MarketMatcherConfig {
  /** Enable semantic matching (requires embeddings service) */
  semanticEnabled?: boolean;
  /** Similarity threshold (0-1) for semantic matching */
  similarityThreshold?: number;
  /** Minimum token overlap for text matching */
  minTokenOverlap?: number;
  /** Cache TTL in ms */
  cacheTtlMs?: number;
}

export interface MarketMatch {
  /** Canonical ID for this match group */
  canonicalId: string;
  /** All matched markets */
  markets: Array<{ platform: Platform; market: Market }>;
  /** Similarity score (0-1) */
  similarity: number;
  /** Match method used */
  method: 'semantic' | 'text' | 'manual' | 'slug';
  /** Normalized question */
  normalizedQuestion: string;
}

export interface MarketMatcher {
  /** Find matching markets across platforms */
  findMatches(
    markets: Array<{ platform: Platform; market: Market }>
  ): Promise<MarketMatch[]>;

  /** Check if two markets match */
  areMatching(
    marketA: { platform: Platform; market: Market },
    marketB: { platform: Platform; market: Market }
  ): Promise<{ matches: boolean; similarity: number; method: string }>;

  /** Add manual link */
  addManualLink(marketA: string, marketB: string): void;

  /** Remove manual link */
  removeManualLink(marketA: string, marketB: string): void;

  /** Get embedding for a market question */
  getEmbedding(question: string): Promise<number[] | null>;

  /** Clear cache */
  clearCache(): void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_CONFIG: Required<MarketMatcherConfig> = {
  semanticEnabled: true,
  similarityThreshold: 0.85,
  minTokenOverlap: 0.6,
  cacheTtlMs: 300000, // 5 minutes
};

// Common stop words to ignore
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'will', 'be', 'is', 'are', 'was', 'were', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'under', 'again', 'further', 'then', 'once', 'here',
  'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
  'because', 'until', 'while', 'this', 'that', 'these', 'those', 'what',
]);

// Entity normalization patterns
const ENTITY_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Dates
  { pattern: /\b(jan|january)\b/gi, replacement: 'january' },
  { pattern: /\b(feb|february)\b/gi, replacement: 'february' },
  { pattern: /\b(mar|march)\b/gi, replacement: 'march' },
  { pattern: /\b(apr|april)\b/gi, replacement: 'april' },
  { pattern: /\b(jun|june)\b/gi, replacement: 'june' },
  { pattern: /\b(jul|july)\b/gi, replacement: 'july' },
  { pattern: /\b(aug|august)\b/gi, replacement: 'august' },
  { pattern: /\b(sep|sept|september)\b/gi, replacement: 'september' },
  { pattern: /\b(oct|october)\b/gi, replacement: 'october' },
  { pattern: /\b(nov|november)\b/gi, replacement: 'november' },
  { pattern: /\b(dec|december)\b/gi, replacement: 'december' },
  // Common entities
  { pattern: /\b(us|u\.s\.|united states)\b/gi, replacement: 'us' },
  { pattern: /\b(uk|u\.k\.|united kingdom|britain)\b/gi, replacement: 'uk' },
  { pattern: /\b(fed|federal reserve|fomc)\b/gi, replacement: 'fed' },
  { pattern: /\b(gdp|gross domestic product)\b/gi, replacement: 'gdp' },
  { pattern: /\b(cpi|consumer price index)\b/gi, replacement: 'cpi' },
  // Numbers
  { pattern: /(\d+)\s*%/g, replacement: '$1percent' },
  { pattern: /\$(\d+)/g, replacement: '$1dollars' },
  { pattern: /(\d+)\s*(bp|bps|basis points?)/gi, replacement: '$1bp' },
];

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function createMarketMatcher(
  db: Database,
  embeddings?: EmbeddingsService,
  config: MarketMatcherConfig = {}
): MarketMatcher {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Manual links
  const manualLinks = new Map<string, Set<string>>();

  // Embedding cache
  const embeddingCache = new Map<string, { embedding: number[]; timestamp: number }>();

  // Load manual links from DB
  loadManualLinks();

  function loadManualLinks(): void {
    try {
      const rows = db.query<{ market_a: string; market_b: string }>(
        'SELECT market_a, market_b FROM market_links WHERE source = ?',
        ['manual']
      );

      for (const row of rows) {
        addToLinkSet(row.market_a, row.market_b);
      }

      logger.debug({ count: rows.length }, 'Loaded manual market links');
    } catch (error) {
      logger.warn({ error }, 'Failed to load manual links');
    }
  }

  function addToLinkSet(a: string, b: string): void {
    if (!manualLinks.has(a)) manualLinks.set(a, new Set());
    if (!manualLinks.has(b)) manualLinks.set(b, new Set());
    manualLinks.get(a)!.add(b);
    manualLinks.get(b)!.add(a);
  }

  function removeFromLinkSet(a: string, b: string): void {
    manualLinks.get(a)?.delete(b);
    manualLinks.get(b)?.delete(a);
  }

  // ===========================================================================
  // NORMALIZATION
  // ===========================================================================

  function normalizeQuestion(question: string): string {
    let normalized = question.toLowerCase().trim();

    // Apply entity patterns
    for (const { pattern, replacement } of ENTITY_PATTERNS) {
      normalized = normalized.replace(pattern, replacement);
    }

    // Remove punctuation except numbers
    normalized = normalized.replace(/[^\w\s\d]/g, ' ');

    // Normalize whitespace
    normalized = normalized.replace(/\s+/g, ' ').trim();

    return normalized;
  }

  function tokenize(text: string): string[] {
    const normalized = normalizeQuestion(text);
    return normalized
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  }

  function generateCanonicalId(question: string): string {
    const tokens = tokenize(question).slice(0, 8);
    return tokens.join('_');
  }

  // ===========================================================================
  // SIMILARITY CALCULATIONS
  // ===========================================================================

  function calculateJaccardSimilarity(tokensA: string[], tokensB: string[]): number {
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);

    const intersection = new Set([...setA].filter((x) => setB.has(x)));
    const union = new Set([...setA, ...setB]);

    if (union.size === 0) return 0;
    return intersection.size / union.size;
  }

  function calculateCosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (normA * normB);
  }

  // ===========================================================================
  // EMBEDDING
  // ===========================================================================

  async function getEmbedding(question: string): Promise<number[] | null> {
    if (!embeddings || !cfg.semanticEnabled) return null;

    const normalized = normalizeQuestion(question);
    const cached = embeddingCache.get(normalized);

    if (cached && Date.now() - cached.timestamp < cfg.cacheTtlMs) {
      return cached.embedding;
    }

    try {
      const result = await embeddings.embed(normalized);
      if (result && result.length > 0) {
        embeddingCache.set(normalized, { embedding: result, timestamp: Date.now() });
        return result;
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to get embedding');
    }

    return null;
  }

  // ===========================================================================
  // MATCHING
  // ===========================================================================

  async function areMatching(
    marketA: { platform: Platform; market: Market },
    marketB: { platform: Platform; market: Market }
  ): Promise<{ matches: boolean; similarity: number; method: string }> {
    const keyA = `${marketA.platform}:${marketA.market.id}`;
    const keyB = `${marketB.platform}:${marketB.market.id}`;

    // 1. Check manual links first
    if (manualLinks.get(keyA)?.has(keyB)) {
      return { matches: true, similarity: 1.0, method: 'manual' };
    }

    // 2. Check slug match (exact ID match across platforms)
    if (marketA.market.slug && marketB.market.slug) {
      const slugA = marketA.market.slug.toLowerCase();
      const slugB = marketB.market.slug.toLowerCase();
      if (slugA === slugB) {
        return { matches: true, similarity: 1.0, method: 'slug' };
      }
    }

    const questionA = marketA.market.question;
    const questionB = marketB.market.question;

    // 3. Try semantic matching
    if (cfg.semanticEnabled && embeddings) {
      const [embA, embB] = await Promise.all([
        getEmbedding(questionA),
        getEmbedding(questionB),
      ]);

      if (embA && embB) {
        const similarity = calculateCosineSimilarity(embA, embB);
        if (similarity >= cfg.similarityThreshold) {
          return { matches: true, similarity, method: 'semantic' };
        }
      }
    }

    // 4. Fall back to text matching
    const tokensA = tokenize(questionA);
    const tokensB = tokenize(questionB);
    const similarity = calculateJaccardSimilarity(tokensA, tokensB);

    if (similarity >= cfg.minTokenOverlap) {
      return { matches: true, similarity, method: 'text' };
    }

    return { matches: false, similarity, method: 'none' };
  }

  async function findMatches(
    markets: Array<{ platform: Platform; market: Market }>
  ): Promise<MarketMatch[]> {
    const matchGroups = new Map<string, MarketMatch>();

    // Group by normalized question first (fast)
    const byNormalized = new Map<string, Array<{ platform: Platform; market: Market }>>();

    for (const item of markets) {
      const normalized = normalizeQuestion(item.market.question);
      const key = generateCanonicalId(item.market.question);

      if (!byNormalized.has(key)) {
        byNormalized.set(key, []);
      }
      byNormalized.get(key)!.push(item);
    }

    // Process groups that have multiple platforms
    for (const [canonicalId, group] of byNormalized) {
      const platforms = new Set(group.map((g) => g.platform));

      if (platforms.size < 2) {
        // Still create match for single platform (for internal arb)
        if (group.length > 0) {
          matchGroups.set(canonicalId, {
            canonicalId,
            markets: group,
            similarity: 1.0,
            method: 'text',
            normalizedQuestion: normalizeQuestion(group[0].market.question),
          });
        }
        continue;
      }

      // Multiple platforms - verify matches
      const verified: Array<{ platform: Platform; market: Market }> = [];
      let bestSimilarity = 0;
      let method: 'semantic' | 'text' | 'manual' | 'slug' = 'text';

      for (let i = 0; i < group.length; i++) {
        if (i === 0) {
          verified.push(group[i]);
          continue;
        }

        const result = await areMatching(group[0], group[i]);
        if (result.matches) {
          verified.push(group[i]);
          if (result.similarity > bestSimilarity) {
            bestSimilarity = result.similarity;
            method = result.method as typeof method;
          }
        }
      }

      if (verified.length >= 1) {
        matchGroups.set(canonicalId, {
          canonicalId,
          markets: verified,
          similarity: bestSimilarity || 1.0,
          method,
          normalizedQuestion: normalizeQuestion(group[0].market.question),
        });
      }
    }

    // Check manual links for additional matches
    for (const [keyA, linkedKeys] of manualLinks) {
      for (const keyB of linkedKeys) {
        const [platformA, marketIdA] = keyA.split(':');
        const [platformB, marketIdB] = keyB.split(':');

        const marketA = markets.find(
          (m) => m.platform === platformA && m.market.id === marketIdA
        );
        const marketB = markets.find(
          (m) => m.platform === platformB && m.market.id === marketIdB
        );

        if (marketA && marketB) {
          const canonicalId = `manual_${keyA}_${keyB}`;
          if (!matchGroups.has(canonicalId)) {
            matchGroups.set(canonicalId, {
              canonicalId,
              markets: [marketA, marketB],
              similarity: 1.0,
              method: 'manual',
              normalizedQuestion: normalizeQuestion(marketA.market.question),
            });
          }
        }
      }
    }

    return Array.from(matchGroups.values());
  }

  // ===========================================================================
  // MANUAL LINKS
  // ===========================================================================

  function addManualLink(marketA: string, marketB: string): void {
    addToLinkSet(marketA, marketB);

    // Persist to DB
    try {
      db.run(
        `INSERT OR REPLACE INTO market_links (id, market_a, market_b, source)
         VALUES (?, ?, ?, ?)`,
        [`${marketA}_${marketB}`, marketA, marketB, 'manual']
      );
    } catch (error) {
      logger.warn({ error }, 'Failed to persist manual link');
    }
  }

  function removeManualLink(marketA: string, marketB: string): void {
    removeFromLinkSet(marketA, marketB);

    try {
      db.run(
        'DELETE FROM market_links WHERE (market_a = ? AND market_b = ?) OR (market_a = ? AND market_b = ?)',
        [marketA, marketB, marketB, marketA]
      );
    } catch (error) {
      logger.warn({ error }, 'Failed to remove manual link');
    }
  }

  function clearCache(): void {
    embeddingCache.clear();
  }

  return {
    findMatches,
    areMatching,
    addManualLink,
    removeManualLink,
    getEmbedding,
    clearCache,
  };
}

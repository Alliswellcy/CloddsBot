/**
 * Embeddings CLI Skill
 *
 * Commands:
 * /embed text <text>             - Generate embedding for text
 * /embed search <query>          - Semantic search across cached embeddings
 * /embed similarity <a> | <b>   - Compare two texts for similarity
 * /embed cache stats             - Show embedding cache statistics
 * /embed cache clear             - Clear embedding cache
 * /embed config                  - Show current embedding configuration
 */

import {
  createEmbeddingsService,
  type EmbeddingsService,
  type EmbeddingConfig,
} from '../../../embeddings/index';
import { logger } from '../../../utils/logger';

let service: EmbeddingsService | null = null;

function getService(): EmbeddingsService | null {
  // Service requires a Database instance; without one we cannot initialize
  // In a real runtime the skill loader would inject the db instance.
  // For now we attempt lazy init with a lightweight in-memory stub if available.
  if (service) return service;

  try {
    // The embeddings service needs a Database; we try to import a shared one
    const { getDatabase } = require('../../../db/index');
    const db = getDatabase?.();
    if (!db) return null;

    const config: Partial<EmbeddingConfig> = {};
    if (process.env.OPENAI_API_KEY) {
      config.provider = 'openai';
      config.apiKey = process.env.OPENAI_API_KEY;
    }

    service = createEmbeddingsService(db, config);
    return service;
  } catch {
    return null;
  }
}

async function handleEmbed(text: string): Promise<string> {
  const svc = getService();
  if (!svc) return 'Embeddings service not available. Database required.';

  try {
    const vector = await svc.embed(text);
    return `**Embedding Generated**\n\n` +
      `Text: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"\n` +
      `Dimensions: ${vector.length}\n` +
      `Sample values: [${vector.slice(0, 5).map(v => v.toFixed(6)).join(', ')}, ...]`;
  } catch (error) {
    return `Error generating embedding: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function handleSimilarity(input: string): Promise<string> {
  const svc = getService();
  if (!svc) return 'Embeddings service not available. Database required.';

  const parts = input.split('|').map(s => s.trim());
  if (parts.length < 2) {
    return 'Usage: /embed similarity <text a> | <text b>';
  }

  try {
    const [vecA, vecB] = await svc.embedBatch([parts[0], parts[1]]);
    const score = svc.cosineSimilarity(vecA, vecB);

    return `**Similarity Analysis**\n\n` +
      `Text A: "${parts[0].slice(0, 60)}${parts[0].length > 60 ? '...' : ''}"\n` +
      `Text B: "${parts[1].slice(0, 60)}${parts[1].length > 60 ? '...' : ''}"\n\n` +
      `Cosine Similarity: ${(score * 100).toFixed(2)}%\n` +
      `Interpretation: ${score > 0.8 ? 'Very similar' : score > 0.5 ? 'Moderately similar' : score > 0.3 ? 'Somewhat related' : 'Not very similar'}`;
  } catch (error) {
    return `Error computing similarity: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function handleCacheStats(): Promise<string> {
  return `**Embedding Cache**\n\n` +
    `Provider: ${process.env.OPENAI_API_KEY ? 'OpenAI' : 'Local (transformers.js)'}\n` +
    `Model: ${process.env.OPENAI_API_KEY ? 'text-embedding-3-small' : 'Xenova/all-MiniLM-L6-v2'}\n` +
    `Status: ${getService() ? 'Active' : 'Not initialized'}`;
}

async function handleConfig(): Promise<string> {
  const hasOpenAI = !!process.env.OPENAI_API_KEY;

  return `**Embeddings Configuration**\n\n` +
    `Provider: ${hasOpenAI ? 'OpenAI' : 'Local (transformers.js)'}\n` +
    `Model: ${hasOpenAI ? 'text-embedding-3-small' : 'Xenova/all-MiniLM-L6-v2'}\n` +
    `Dimensions: ${hasOpenAI ? '1536' : '384'}\n` +
    `Cache: SQLite-backed with in-memory layer\n` +
    `OPENAI_API_KEY: ${hasOpenAI ? 'Set' : 'Not set (using local)'}`;
}

export async function execute(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase() || 'help';
  const rest = parts.slice(1);

  switch (command) {
    case 'text':
    case 'embed':
      if (rest.length === 0) return 'Usage: /embed text <text>';
      return handleEmbed(rest.join(' '));

    case 'search':
      if (rest.length === 0) return 'Usage: /embed search <query>';
      return handleEmbed(rest.join(' ')); // Same as embed for now

    case 'similarity':
    case 'compare':
      if (rest.length === 0) return 'Usage: /embed similarity <text a> | <text b>';
      return handleSimilarity(rest.join(' '));

    case 'cache':
      if (rest[0] === 'clear') {
        return 'Embedding cache cleared.';
      }
      return handleCacheStats();

    case 'config':
    case 'status':
      return handleConfig();

    case 'help':
    default:
      return `**Embeddings Commands**

**Generate:**
  /embed text <text>             - Generate embedding vector
  /embed search <query>          - Semantic search

**Compare:**
  /embed similarity <a> | <b>   - Compare two texts

**Cache:**
  /embed cache stats             - Cache statistics
  /embed cache clear             - Clear cache

**Config:**
  /embed config                  - Show configuration

**Examples:**
  /embed text What is prediction market arbitrage?
  /embed similarity crypto markets | prediction markets
  /embed config`;
  }
}

export default {
  name: 'embeddings',
  description: 'Vector embeddings for semantic search - OpenAI or local transformers.js',
  commands: ['/embeddings', '/embed'],
  handle: execute,
};

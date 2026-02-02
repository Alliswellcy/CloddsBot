/**
 * Prompt Handler - Natural language prompt processing
 *
 * Transforms user prompts into executable actions using the agent system.
 */

import { EventEmitter } from 'eventemitter3';
import { logger } from '../utils/logger';
import type {
  ApiRequest,
  PromptResultData,
  PromptAction,
  TransactionResult,
  PricingTier,
} from './types';

// =============================================================================
// TYPES
// =============================================================================

export interface PromptHandler {
  /** Process a prompt and return result */
  process(request: ApiRequest, tier: PricingTier): Promise<PromptResult>;
  /** Classify prompt into action type */
  classifyAction(prompt: string): PromptAction;
  /** Check if prompt requires custody wallet */
  requiresCustody(prompt: string): boolean;
  /** Validate prompt before processing */
  validate(prompt: string): ValidationResult;
  /** Get supported actions */
  getSupportedActions(): PromptAction[];
}

export interface PromptResult {
  success: boolean;
  data?: PromptResultData;
  error?: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: string;
}

export interface PromptHandlerConfig {
  /** Maximum prompt length (default: 2000) */
  maxLength?: number;
  /** Timeout for processing (default: 60000ms) */
  timeout?: number;
  /** Agent model to use (default: 'claude-3-5-sonnet-latest') */
  model?: string;
  /** Enable dry run mode (default: false) */
  dryRun?: boolean;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_CONFIG: Required<PromptHandlerConfig> = {
  maxLength: 2000,
  timeout: 60000,
  model: 'claude-3-5-sonnet-latest',
  dryRun: false,
};

// Action classification patterns
const ACTION_PATTERNS: Record<PromptAction, RegExp[]> = {
  query: [
    /(?:what|how much|show|get|check|display|list|view|lookup|find).*(?:price|balance|position|portfolio|status|info)/i,
    /(?:price|balance|value|worth|pnl|profit|loss).*(?:of|for|is)/i,
  ],
  trade: [
    /(?:buy|sell|long|short).*(?:\$|usd|usdc|token|share|contract)/i,
    /(?:place|submit|execute).*(?:order|trade|bet|position)/i,
    /(?:market|limit).*(?:buy|sell|order)/i,
  ],
  swap: [
    /swap.*(?:for|to|into)/i,
    /(?:exchange|convert|trade).*(?:for|to|into)/i,
  ],
  transfer: [
    /(?:send|transfer|move).*(?:to|from)/i,
    /(?:withdraw|deposit)/i,
  ],
  stake: [
    /(?:stake|lock|delegate)/i,
  ],
  unstake: [
    /(?:unstake|unlock|undelegate|withdraw.*stake)/i,
  ],
  claim: [
    /(?:claim|collect|harvest).*(?:reward|yield|earning|airdrop)/i,
  ],
  approve: [
    /(?:approve|allow|permit).*(?:spend|token|contract)/i,
  ],
  bridge: [
    /(?:bridge|cross-chain|transfer.*chain)/i,
  ],
  analysis: [
    /(?:analyze|analyse|research|compare|evaluate)/i,
    /(?:should i|is it good|worth|recommend)/i,
  ],
  automation: [
    /(?:automate|schedule|recurring|trigger|alert|notify)/i,
    /(?:set up|create).*(?:bot|strategy|rule)/i,
    /(?:copy|follow|mirror).*(?:trade|wallet|trader)/i,
    /(?:dca|dollar cost|ladder)/i,
  ],
  unknown: [],
};

// Patterns that indicate execution (vs read-only)
const EXECUTION_PATTERNS = [
  /(?:buy|sell|swap|trade|transfer|send|stake|unstake|claim|approve|bridge)/i,
  /(?:execute|submit|place|create|set up)/i,
];

// Forbidden patterns (safety)
const FORBIDDEN_PATTERNS = [
  /(?:hack|exploit|steal|drain|rug)/i,
  /(?:private.*key|seed.*phrase|mnemonic)/i,
  /(?:all.*funds|entire.*balance|max.*out)/i,
];

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function createPromptHandler(config: PromptHandlerConfig = {}): PromptHandler {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  function validate(prompt: string): ValidationResult {
    // Check length
    if (!prompt || prompt.trim().length === 0) {
      return { valid: false, error: 'Prompt cannot be empty' };
    }

    if (prompt.length > cfg.maxLength) {
      return { valid: false, error: `Prompt exceeds maximum length of ${cfg.maxLength} characters` };
    }

    // Check for forbidden patterns
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(prompt)) {
        return { valid: false, error: 'Prompt contains forbidden content' };
      }
    }

    // Sanitize
    const sanitized = prompt
      .trim()
      .replace(/\s+/g, ' ')           // Normalize whitespace
      .replace(/[<>]/g, '')           // Remove potential HTML
      .slice(0, cfg.maxLength);

    return { valid: true, sanitized };
  }

  function classifyAction(prompt: string): PromptAction {
    const normalized = prompt.toLowerCase();

    // Check each action type
    for (const [action, patterns] of Object.entries(ACTION_PATTERNS)) {
      if (action === 'unknown') continue;

      for (const pattern of patterns) {
        if (pattern.test(normalized)) {
          return action as PromptAction;
        }
      }
    }

    return 'unknown';
  }

  function requiresCustody(prompt: string): boolean {
    // Execution actions require custody
    for (const pattern of EXECUTION_PATTERNS) {
      if (pattern.test(prompt)) {
        return true;
      }
    }
    return false;
  }

  async function process(request: ApiRequest, tier: PricingTier): Promise<PromptResult> {
    const startTime = Date.now();

    try {
      // Validate prompt
      const validation = validate(request.prompt);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      const prompt = validation.sanitized || request.prompt;
      const action = classifyAction(prompt);

      logger.info({
        requestId: request.id,
        wallet: request.wallet,
        action,
        tier,
        promptLength: prompt.length,
      }, 'Processing prompt');

      // In dry run mode, return mock result
      if (cfg.dryRun) {
        return createMockResult(action, prompt, startTime);
      }

      // Process based on action type
      let result: PromptResultData;

      switch (action) {
        case 'query':
          result = await processQuery(request, prompt);
          break;
        case 'trade':
          result = await processTrade(request, prompt);
          break;
        case 'swap':
          result = await processSwap(request, prompt);
          break;
        case 'transfer':
          result = await processTransfer(request, prompt);
          break;
        case 'analysis':
          result = await processAnalysis(request, prompt);
          break;
        case 'automation':
          result = await processAutomation(request, prompt);
          break;
        default:
          // Use generic agent processing
          result = await processGeneric(request, prompt, action);
      }

      result.executionTime = Date.now() - startTime;
      return { success: true, data: result };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error({ requestId: request.id, error: errorMsg }, 'Prompt processing failed');
      return { success: false, error: errorMsg };
    }
  }

  function createMockResult(action: PromptAction, prompt: string, startTime: number): PromptResult {
    return {
      success: true,
      data: {
        action,
        summary: `[DRY RUN] Would execute ${action} action for: "${prompt.slice(0, 50)}..."`,
        data: { dryRun: true, prompt },
        executionTime: Date.now() - startTime,
      },
    };
  }

  async function processQuery(request: ApiRequest, prompt: string): Promise<PromptResultData> {
    // TODO: Integrate with actual data providers
    // For now, return placeholder
    return {
      action: 'query',
      summary: 'Query processed successfully',
      data: {
        prompt,
        timestamp: Date.now(),
        // Would include actual query results here
      },
      executionTime: 0,
    };
  }

  async function processTrade(request: ApiRequest, prompt: string): Promise<PromptResultData> {
    // TODO: Parse trade parameters and execute via execution service
    // Would use: src/execution/ for trade execution
    return {
      action: 'trade',
      summary: 'Trade execution requires custody wallet',
      data: { prompt, requiresCustody: true },
      executionTime: 0,
    };
  }

  async function processSwap(request: ApiRequest, prompt: string): Promise<PromptResultData> {
    // TODO: Parse swap parameters and execute
    return {
      action: 'swap',
      summary: 'Swap execution requires custody wallet',
      data: { prompt, requiresCustody: true },
      executionTime: 0,
    };
  }

  async function processTransfer(request: ApiRequest, prompt: string): Promise<PromptResultData> {
    // TODO: Parse transfer parameters and execute
    return {
      action: 'transfer',
      summary: 'Transfer execution requires custody wallet',
      data: { prompt, requiresCustody: true },
      executionTime: 0,
    };
  }

  async function processAnalysis(request: ApiRequest, prompt: string): Promise<PromptResultData> {
    // TODO: Run analysis using agent with analysis tools
    return {
      action: 'analysis',
      summary: 'Analysis complete',
      data: { prompt, analysis: {} },
      executionTime: 0,
    };
  }

  async function processAutomation(request: ApiRequest, prompt: string): Promise<PromptResultData> {
    // TODO: Set up automation rules
    return {
      action: 'automation',
      summary: 'Automation setup requires premium tier',
      data: { prompt, requiresPremium: true },
      executionTime: 0,
    };
  }

  async function processGeneric(request: ApiRequest, prompt: string, action: PromptAction): Promise<PromptResultData> {
    // TODO: Use full agent system for complex/unknown prompts
    return {
      action,
      summary: `Processed as ${action} action`,
      data: { prompt },
      executionTime: 0,
    };
  }

  function getSupportedActions(): PromptAction[] {
    return Object.keys(ACTION_PATTERNS).filter(a => a !== 'unknown') as PromptAction[];
  }

  return {
    process,
    classifyAction,
    requiresCustody,
    validate,
    getSupportedActions,
  };
}

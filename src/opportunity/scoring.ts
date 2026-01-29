/**
 * Opportunity Scoring - Liquidity-adjusted opportunity scoring and ranking
 *
 * Features:
 * - Liquidity-adjusted profitability
 * - Slippage estimation
 * - Kelly criterion integration
 * - Execution risk assessment
 * - Multi-factor scoring
 */

import type { Platform } from '../types';
import { logger } from '../utils/logger';

// =============================================================================
// TYPES
// =============================================================================

export interface OpportunityScorerConfig {
  /** Minimum liquidity to consider */
  minLiquidity?: number;
  /** Weight for edge in score (0-1) */
  edgeWeight?: number;
  /** Weight for liquidity in score (0-1) */
  liquidityWeight?: number;
  /** Weight for confidence in score (0-1) */
  confidenceWeight?: number;
  /** Weight for execution feasibility in score (0-1) */
  executionWeight?: number;
  /** Maximum slippage % to consider */
  maxSlippage?: number;
}

export interface ScoredOpportunity {
  /** Overall score (0-100) */
  score: number;
  /** Liquidity-adjusted edge */
  adjustedEdge: number;
  /** Estimated slippage at recommended size */
  estimatedSlippage: number;
  /** Kelly fraction recommendation */
  kellyFraction: number;
  /** Execution feasibility score (0-1) */
  executionScore: number;
  /** Score breakdown */
  breakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  /** Edge contribution to score */
  edgeScore: number;
  /** Liquidity contribution */
  liquidityScore: number;
  /** Confidence contribution */
  confidenceScore: number;
  /** Execution feasibility contribution */
  executionScore: number;
  /** Penalties applied */
  penalties: Array<{ reason: string; amount: number }>;
}

export interface ExecutionPlan {
  steps: ExecutionStep[];
  totalCost: number;
  estimatedProfit: number;
  timeSensitivity: number;
  risk: 'low' | 'medium' | 'high';
  warnings: string[];
}

export interface ExecutionStep {
  order: number;
  platform: Platform;
  marketId: string;
  action: 'buy' | 'sell';
  outcome: string;
  price: number;
  size: number;
  orderType: 'market' | 'limit' | 'maker';
}

export interface OpportunityScorer {
  /** Score an opportunity */
  score(opportunity: OpportunityInput): ScoredOpportunity;

  /** Estimate slippage for a given size */
  estimateSlippage(
    liquidity: number,
    size: number,
    spreadPct?: number
  ): number;

  /** Calculate Kelly fraction */
  calculateKelly(
    edge: number,
    confidence: number,
    winRate?: number
  ): number;

  /** Estimate execution for opportunity at given size */
  estimateExecution(opportunity: OpportunityInput, size: number): ExecutionPlan;

  /** Get optimal size for opportunity */
  getOptimalSize(opportunity: OpportunityInput, bankroll: number): number;
}

interface OpportunityInput {
  type: 'internal' | 'cross_platform' | 'edge';
  markets: Array<{
    platform: Platform;
    price: number;
    liquidity: number;
    volume24h: number;
    bidPrice?: number;
    askPrice?: number;
    spreadPct?: number;
    action: 'buy' | 'sell';
  }>;
  edgePct: number;
  confidence: number;
  totalLiquidity: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_CONFIG: Required<OpportunityScorerConfig> = {
  minLiquidity: 100,
  edgeWeight: 0.35,
  liquidityWeight: 0.25,
  confidenceWeight: 0.25,
  executionWeight: 0.15,
  maxSlippage: 5,
};

// Platform-specific slippage factors (higher = more slippage)
const PLATFORM_SLIPPAGE_FACTORS: Record<string, number> = {
  polymarket: 0.8,  // Good liquidity
  kalshi: 1.0,      // Moderate
  manifold: 1.5,    // Less liquid
  predictit: 1.2,
  metaculus: 2.0,   // Least liquid
  drift: 0.9,
  betfair: 0.6,     // Best liquidity
  smarkets: 0.7,
};

// Platform execution reliability (0-1)
const PLATFORM_RELIABILITY: Record<string, number> = {
  polymarket: 0.95,
  kalshi: 0.95,
  manifold: 0.85,
  predictit: 0.80,
  metaculus: 0.70,  // Manual resolution
  drift: 0.90,
  betfair: 0.98,
  smarkets: 0.95,
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function createOpportunityScorer(
  config: OpportunityScorerConfig = {}
): OpportunityScorer {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // ===========================================================================
  // SLIPPAGE ESTIMATION
  // ===========================================================================

  function estimateSlippage(
    liquidity: number,
    size: number,
    spreadPct?: number
  ): number {
    if (liquidity <= 0 || size <= 0) return 0;

    // Base slippage from size/liquidity ratio
    const sizeRatio = size / liquidity;

    // Square root model for market impact
    const impactSlippage = Math.sqrt(sizeRatio) * 2;

    // Add half the spread
    const spreadSlippage = (spreadPct || 1) / 2;

    // Total slippage
    return Math.min(impactSlippage + spreadSlippage, 50);
  }

  function estimatePlatformSlippage(
    platform: Platform,
    liquidity: number,
    size: number,
    spreadPct?: number
  ): number {
    const base = estimateSlippage(liquidity, size, spreadPct);
    const factor = PLATFORM_SLIPPAGE_FACTORS[platform] || 1.0;
    return base * factor;
  }

  // ===========================================================================
  // KELLY CRITERION
  // ===========================================================================

  function calculateKelly(
    edge: number,
    confidence: number,
    winRate?: number
  ): number {
    // edge is already in decimal form (e.g., 0.05 for 5%)
    const effectiveEdge = edge * confidence;

    // Use win rate if provided, otherwise estimate from edge
    const p = winRate || 0.5 + effectiveEdge / 2;
    const q = 1 - p;

    // Assuming even money odds (b = 1)
    // Kelly = (bp - q) / b = p - q = 2p - 1
    const fullKelly = 2 * p - 1;

    // Apply safety factor based on confidence
    const safetyFactor = 0.25 * confidence; // Quarter Kelly at full confidence

    const kelly = Math.max(0, fullKelly * safetyFactor);

    return Math.min(kelly, 0.25); // Cap at 25%
  }

  // ===========================================================================
  // SCORING
  // ===========================================================================

  function score(opportunity: OpportunityInput): ScoredOpportunity {
    const penalties: Array<{ reason: string; amount: number }> = [];

    // 1. Edge Score (0-40)
    const normalizedEdge = Math.min(opportunity.edgePct / 10, 1); // 10% edge = max
    let edgeScore = normalizedEdge * 40;

    // 2. Liquidity Score (0-25)
    const liquidityK = opportunity.totalLiquidity / 1000;
    const normalizedLiquidity = Math.min(liquidityK / 50, 1); // $50k = max
    let liquidityScore = normalizedLiquidity * 25;

    // 3. Confidence Score (0-25)
    let confidenceScore = opportunity.confidence * 25;

    // 4. Execution Score (0-10)
    let executionScore = calculateExecutionScore(opportunity);

    // Apply penalties
    // - Low liquidity penalty
    if (opportunity.totalLiquidity < cfg.minLiquidity * 5) {
      const penalty = 5 * (1 - opportunity.totalLiquidity / (cfg.minLiquidity * 5));
      penalties.push({ reason: 'Low liquidity', amount: penalty });
      liquidityScore -= penalty;
    }

    // - Cross-platform complexity penalty
    if (opportunity.type === 'cross_platform') {
      const platforms = new Set(opportunity.markets.map((m) => m.platform));
      if (platforms.size > 1) {
        const penalty = 3 * (platforms.size - 1);
        penalties.push({ reason: 'Cross-platform execution', amount: penalty });
        executionScore -= penalty;
      }
    }

    // - High slippage penalty
    const avgSlippage = calculateAverageSlippage(opportunity, 100);
    if (avgSlippage > 2) {
      const penalty = Math.min(5, (avgSlippage - 2) * 2);
      penalties.push({ reason: 'High slippage', amount: penalty });
      edgeScore -= penalty;
    }

    // - Edge vs fair value uncertainty penalty
    if (opportunity.type === 'edge' && opportunity.confidence < 0.7) {
      const penalty = 5 * (1 - opportunity.confidence);
      penalties.push({ reason: 'Low fair value confidence', amount: penalty });
      confidenceScore -= penalty;
    }

    // Ensure scores are non-negative
    edgeScore = Math.max(0, edgeScore);
    liquidityScore = Math.max(0, liquidityScore);
    confidenceScore = Math.max(0, confidenceScore);
    executionScore = Math.max(0, executionScore);

    const totalScore = edgeScore + liquidityScore + confidenceScore + executionScore;

    // Calculate adjusted edge
    const adjustedEdge = opportunity.edgePct - avgSlippage;

    // Calculate Kelly
    const kellyFraction = calculateKelly(
      opportunity.edgePct / 100,
      opportunity.confidence
    );

    return {
      score: Math.round(totalScore * 10) / 10,
      adjustedEdge: Math.round(adjustedEdge * 100) / 100,
      estimatedSlippage: Math.round(avgSlippage * 100) / 100,
      kellyFraction: Math.round(kellyFraction * 1000) / 1000,
      executionScore: executionScore / 10,
      breakdown: {
        edgeScore: Math.round(edgeScore * 10) / 10,
        liquidityScore: Math.round(liquidityScore * 10) / 10,
        confidenceScore: Math.round(confidenceScore * 10) / 10,
        executionScore: Math.round(executionScore * 10) / 10,
        penalties,
      },
    };
  }

  function calculateExecutionScore(opportunity: OpportunityInput): number {
    let score = 10;

    for (const market of opportunity.markets) {
      const reliability = PLATFORM_RELIABILITY[market.platform] || 0.8;
      score *= reliability;
    }

    // Penalize if selling is required (not all platforms support)
    const hasSell = opportunity.markets.some((m) => m.action === 'sell');
    if (hasSell) {
      score *= 0.9;
    }

    return score;
  }

  function calculateAverageSlippage(
    opportunity: OpportunityInput,
    size: number
  ): number {
    if (opportunity.markets.length === 0) return 0;

    const perMarketSize = size / opportunity.markets.length;
    let totalSlippage = 0;

    for (const market of opportunity.markets) {
      const slippage = estimatePlatformSlippage(
        market.platform,
        market.liquidity,
        perMarketSize,
        market.spreadPct
      );
      totalSlippage += slippage;
    }

    return totalSlippage / opportunity.markets.length;
  }

  // ===========================================================================
  // EXECUTION PLANNING
  // ===========================================================================

  function estimateExecution(
    opportunity: OpportunityInput,
    size: number
  ): ExecutionPlan {
    const perMarketSize = size / opportunity.markets.length;
    const steps: ExecutionStep[] = [];
    const warnings: string[] = [];

    let totalCost = 0;
    let estimatedProfit = 0;
    let maxRisk: 'low' | 'medium' | 'high' = 'low';

    for (let i = 0; i < opportunity.markets.length; i++) {
      const market = opportunity.markets[i];
      const slippage = estimatePlatformSlippage(
        market.platform,
        market.liquidity,
        perMarketSize,
        market.spreadPct
      );

      // Adjust price for slippage
      const adjustedPrice = market.action === 'buy'
        ? market.price * (1 + slippage / 100)
        : market.price * (1 - slippage / 100);

      steps.push({
        order: i + 1,
        platform: market.platform,
        marketId: '', // Will be filled in by caller
        action: market.action,
        outcome: '', // Will be filled in by caller
        price: Math.round(adjustedPrice * 10000) / 10000,
        size: perMarketSize,
        orderType: slippage > 1 ? 'limit' : 'market',
      });

      if (market.action === 'buy') {
        totalCost += adjustedPrice * perMarketSize;
      }

      // Assess risk
      if (slippage > 3) {
        maxRisk = 'high';
        warnings.push(`High slippage expected on ${market.platform} (${slippage.toFixed(1)}%)`);
      } else if (slippage > 1.5) {
        if (maxRisk === 'low') maxRisk = 'medium';
      }

      // Check liquidity
      if (perMarketSize > market.liquidity * 0.1) {
        warnings.push(`Order size is >10% of ${market.platform} liquidity`);
      }
    }

    // Estimate profit
    const adjustedEdge = opportunity.edgePct - calculateAverageSlippage(opportunity, size);
    estimatedProfit = (adjustedEdge / 100) * size;

    // Time sensitivity
    let timeSensitivity = 60; // Default 60 seconds
    if (opportunity.type === 'cross_platform') {
      timeSensitivity = 15;
    }
    if (maxRisk === 'high') {
      timeSensitivity = Math.max(5, timeSensitivity / 2);
    }

    // Add warnings for cross-platform
    if (opportunity.type === 'cross_platform') {
      const platforms = new Set(opportunity.markets.map((m) => m.platform));
      if (platforms.size > 1) {
        warnings.push('Requires accounts on multiple platforms');
        warnings.push('Prices may move between executions');
      }
    }

    return {
      steps,
      totalCost: Math.round(totalCost * 100) / 100,
      estimatedProfit: Math.round(estimatedProfit * 100) / 100,
      timeSensitivity,
      risk: maxRisk,
      warnings,
    };
  }

  // ===========================================================================
  // OPTIMAL SIZING
  // ===========================================================================

  function getOptimalSize(opportunity: OpportunityInput, bankroll: number): number {
    const kellyFraction = calculateKelly(
      opportunity.edgePct / 100,
      opportunity.confidence
    );

    // Kelly-based size
    const kellySize = bankroll * kellyFraction;

    // Liquidity-based max (don't take more than 5% of liquidity)
    const liquidityMax = opportunity.totalLiquidity * 0.05;

    // Slippage-based max (keep slippage under 2%)
    let slippageMax = Infinity;
    for (let size = 10; size <= bankroll; size += 10) {
      const slippage = calculateAverageSlippage(opportunity, size);
      if (slippage > 2) {
        slippageMax = size - 10;
        break;
      }
    }

    // Take minimum of all constraints
    const optimalSize = Math.min(kellySize, liquidityMax, slippageMax, bankroll * 0.1);

    return Math.max(0, Math.round(optimalSize * 100) / 100);
  }

  return {
    score,
    estimateSlippage,
    calculateKelly,
    estimateExecution,
    getOptimalSize,
  };
}

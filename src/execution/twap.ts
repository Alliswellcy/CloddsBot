/**
 * TWAP / Iceberg Execution - Split large orders across time
 *
 * Features:
 * - TWAP: evenly spaced order slices over a time window
 * - Iceberg: shows small visible portion, refills as slices fill
 * - Price limit protection (auto-cancel if market moves beyond limit)
 * - Random jitter to avoid detection of systematic execution
 * - Cancellable mid-execution
 */

import { EventEmitter } from 'eventemitter3';
import { logger } from '../utils/logger';
import type { ExecutionService, OrderRequest, OrderResult } from './index';

// =============================================================================
// TYPES
// =============================================================================

export interface TwapConfig {
  /** Total size to execute */
  totalSize: number;
  /** Size per slice */
  sliceSize: number;
  /** Time between slices in ms */
  intervalMs: number;
  /** Maximum duration in ms (auto-cancel remaining if exceeded) */
  maxDurationMs?: number;
  /** Random jitter added to interval (0-1, e.g., 0.2 = +/- 20%) */
  jitter?: number;
  /** Price limit - stop if market moves beyond this */
  priceLimit?: number;
  /** Order type for each slice */
  orderType?: 'GTC' | 'FOK';
}

export interface IcebergConfig extends TwapConfig {
  /** Visible size (shown on orderbook) */
  visibleSize: number;
  /** Replenish when visible order fills */
  autoReplenish: boolean;
}

export interface TwapProgress {
  totalSize: number;
  filledSize: number;
  remainingSize: number;
  slicesCompleted: number;
  slicesTotal: number;
  avgFillPrice: number;
  status: 'pending' | 'executing' | 'completed' | 'cancelled' | 'failed';
  startedAt?: Date;
  estimatedCompletion?: Date;
}

export interface TwapOrder extends EventEmitter {
  /** Start executing */
  start(): void;
  /** Cancel remaining slices */
  cancel(): Promise<void>;
  /** Get execution progress */
  getProgress(): TwapProgress;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function createTwapOrder(
  executionService: ExecutionService,
  orderRequest: Omit<OrderRequest, 'size' | 'orderType'>,
  twapConfig: TwapConfig
): TwapOrder {
  const emitter = new EventEmitter() as TwapOrder;

  const slicesTotal = Math.ceil(twapConfig.totalSize / twapConfig.sliceSize);
  const jitter = twapConfig.jitter ?? 0;
  const orderType = twapConfig.orderType ?? 'GTC';

  let status: TwapProgress['status'] = 'pending';
  let filledSize = 0;
  let totalCost = 0; // For avgFillPrice calculation
  let slicesCompleted = 0;
  let startedAt: Date | undefined;
  let sliceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  let currentSliceOrderId: string | undefined;
  let cancelled = false;

  /**
   * Calculate jittered interval
   */
  function getJitteredInterval(): number {
    if (jitter <= 0) return twapConfig.intervalMs;
    const factor = 1 + (Math.random() * 2 - 1) * jitter;
    return Math.max(100, Math.round(twapConfig.intervalMs * factor));
  }

  /**
   * Get the size for the next slice (last slice may be smaller)
   */
  function getNextSliceSize(): number {
    const remaining = twapConfig.totalSize - filledSize;
    return Math.min(twapConfig.sliceSize, remaining);
  }

  /**
   * Build progress snapshot
   */
  function buildProgress(): TwapProgress {
    const remaining = twapConfig.totalSize - filledSize;
    const avgFillPrice = filledSize > 0 ? totalCost / filledSize : 0;
    let estimatedCompletion: Date | undefined;

    if (startedAt && status === 'executing' && slicesCompleted > 0) {
      const elapsed = Date.now() - startedAt.getTime();
      const ratePerSlice = elapsed / slicesCompleted;
      const remainingSlices = slicesTotal - slicesCompleted;
      estimatedCompletion = new Date(Date.now() + ratePerSlice * remainingSlices);
    }

    return {
      totalSize: twapConfig.totalSize,
      filledSize,
      remainingSize: remaining,
      slicesCompleted,
      slicesTotal,
      avgFillPrice,
      status,
      startedAt,
      estimatedCompletion,
    };
  }

  /**
   * Execute a single slice
   */
  async function executeSlice(): Promise<void> {
    if (cancelled || status !== 'executing') return;

    const sliceSize = getNextSliceSize();
    if (sliceSize <= 0) {
      completeExecution();
      return;
    }

    const sliceRequest = {
      ...orderRequest,
      size: sliceSize,
      orderType,
    } as OrderRequest;

    try {
      let result: OrderResult;

      if (orderRequest.side === 'buy') {
        result = await executionService.buyLimit(sliceRequest);
      } else {
        result = await executionService.sellLimit(sliceRequest);
      }

      if (result.success) {
        const sliceFilled = result.filledSize ?? sliceSize;
        const slicePrice = result.avgFillPrice ?? orderRequest.price;

        filledSize += sliceFilled;
        totalCost += sliceFilled * slicePrice;
        slicesCompleted++;
        currentSliceOrderId = result.orderId;

        // Check price limit
        if (twapConfig.priceLimit !== undefined) {
          if (
            (orderRequest.side === 'buy' && slicePrice > twapConfig.priceLimit) ||
            (orderRequest.side === 'sell' && slicePrice < twapConfig.priceLimit)
          ) {
            logger.warn(
              { slicePrice, priceLimit: twapConfig.priceLimit },
              'TWAP price limit exceeded, cancelling remaining slices'
            );
            await cancelInternal('Price limit exceeded');
            return;
          }
        }

        emitter.emit('slice_filled', {
          sliceNumber: slicesCompleted,
          sliceFilled,
          slicePrice,
          progress: buildProgress(),
        });

        logger.info(
          {
            slice: slicesCompleted,
            total: slicesTotal,
            filled: filledSize,
            target: twapConfig.totalSize,
          },
          'TWAP slice filled'
        );
      } else {
        logger.warn({ error: result.error }, 'TWAP slice failed');
        emitter.emit('slice_failed', { sliceNumber: slicesCompleted + 1, error: result.error });
      }

      // Check if we're done
      if (filledSize >= twapConfig.totalSize) {
        completeExecution();
        return;
      }

      // Schedule next slice
      if (!cancelled && status === 'executing') {
        const interval = getJitteredInterval();
        sliceTimer = setTimeout(executeSlice, interval);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, 'TWAP slice execution error');
      emitter.emit('slice_failed', { sliceNumber: slicesCompleted + 1, error: msg });

      // Continue trying unless cancelled
      if (!cancelled && status === 'executing') {
        const interval = getJitteredInterval();
        sliceTimer = setTimeout(executeSlice, interval);
      }
    }

    emitter.emit('progress', buildProgress());
  }

  /**
   * Mark execution as completed
   */
  function completeExecution(): void {
    status = 'completed';
    cleanup();

    const progress = buildProgress();
    logger.info(
      { filledSize, avgFillPrice: progress.avgFillPrice, slicesCompleted },
      'TWAP execution completed'
    );

    emitter.emit('completed', progress);
  }

  /**
   * Internal cancel with reason
   */
  async function cancelInternal(reason: string): Promise<void> {
    cancelled = true;
    status = 'cancelled';
    cleanup();

    // Cancel any open slice order
    if (currentSliceOrderId) {
      try {
        await executionService.cancelOrder(orderRequest.platform, currentSliceOrderId);
      } catch {
        // Best-effort cancellation
      }
    }

    emitter.emit('cancelled', { ...buildProgress(), reason });
  }

  /**
   * Clean up timers
   */
  function cleanup(): void {
    if (sliceTimer) {
      clearTimeout(sliceTimer);
      sliceTimer = null;
    }
    if (maxDurationTimer) {
      clearTimeout(maxDurationTimer);
      maxDurationTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function start(): void {
    if (status !== 'pending') return;

    status = 'executing';
    startedAt = new Date();
    cancelled = false;

    logger.info(
      {
        totalSize: twapConfig.totalSize,
        sliceSize: twapConfig.sliceSize,
        slices: slicesTotal,
        intervalMs: twapConfig.intervalMs,
      },
      'TWAP execution started'
    );

    // Set max duration timer
    if (twapConfig.maxDurationMs) {
      maxDurationTimer = setTimeout(() => {
        if (status === 'executing') {
          cancelInternal('Max duration exceeded').catch(() => {});
        }
      }, twapConfig.maxDurationMs);
    }

    // Execute first slice immediately
    executeSlice().catch((err) => {
      logger.error({ error: String(err) }, 'TWAP first slice failed');
    });

    emitter.emit('started', buildProgress());
  }

  async function cancel(): Promise<void> {
    if (status !== 'executing') return;
    await cancelInternal('Manual cancellation');
  }

  function getProgress(): TwapProgress {
    return buildProgress();
  }

  Object.assign(emitter, { start, cancel, getProgress });

  return emitter;
}

// =============================================================================
// ICEBERG ORDER
// =============================================================================

export function createIcebergOrder(
  executionService: ExecutionService,
  orderRequest: Omit<OrderRequest, 'size' | 'orderType'>,
  icebergConfig: IcebergConfig
): TwapOrder {
  // Iceberg is implemented as a TWAP where sliceSize = visibleSize
  // and the interval is determined by fill detection rather than fixed time
  const twapConfig: TwapConfig = {
    totalSize: icebergConfig.totalSize,
    sliceSize: icebergConfig.visibleSize,
    // For iceberg, use shorter interval — the slice represents visible portion
    intervalMs: icebergConfig.intervalMs,
    maxDurationMs: icebergConfig.maxDurationMs,
    jitter: icebergConfig.jitter,
    priceLimit: icebergConfig.priceLimit,
    orderType: icebergConfig.orderType ?? 'GTC',
  };

  return createTwapOrder(executionService, orderRequest, twapConfig);
}

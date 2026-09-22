// Retries a refund that previously failed against Mercado Pago (see
// /internal/refund-by-payment in app.js, which marks a transaction 'refund_failed'
// instead of silently losing track of it) -- without this, a transient MP failure (a
// timeout, a momentary outage) would sit "flagged for manual review" forever even though
// simply trying again a bit later would very often just work.
import { config } from './config.js';
import { listRefundFailedTransactions, markTransactionAsRefundedByPaymentId, markTransactionAsRefundFailed } from './db.js';
import { refundPayment } from './mercadoPago.js';

export async function retryFailedRefunds() {
  const pending = await listRefundFailedTransactions(config.refundRetryMaxAttempts);
  for (const { payment_id: paymentId } of pending) {
    try {
      await refundPayment(paymentId);
      await markTransactionAsRefundedByPaymentId(paymentId);
      console.log(`[RefundRetry] Refunded payment ${paymentId} on retry`);
    } catch (error) {
      // Still failing -- markTransactionAsRefundFailed bumps refund_attempts, so once it
      // hits config.refundRetryMaxAttempts this same transaction stops being picked up by
      // listRefundFailedTransactions above, and genuinely needs a human.
      console.error(`[RefundRetry] Refund retry failed for payment ${paymentId}:`, error);
      await markTransactionAsRefundFailed(paymentId);
    }
  }
  return pending.length;
}

/** Starts the interval and returns its handle, so callers (tests, graceful shutdown) can
 * clearInterval() it -- mirrors how booking-service's own background jobs are started and
 * stopped via a cancellable context. */
export function startRefundRetryJob() {
  const intervalMs = config.refundRetryIntervalMinutes * 60_000;
  return setInterval(() => {
    retryFailedRefunds().catch((error) => {
      console.error('[RefundRetry] Job tick failed:', error);
    });
  }, intervalMs);
}

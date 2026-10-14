import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function initDatabase() {
  const sql = `
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      payment_id VARCHAR(128) UNIQUE NOT NULL,
      preference_id VARCHAR(128),
      external_reference VARCHAR(255),
      order_id BIGINT,
      amount NUMERIC(12, 2) NOT NULL,
      currency VARCHAR(8) NOT NULL,
      status VARCHAR(32) NOT NULL,
      payer_email VARCHAR(255),
      raw_payload JSONB NOT NULL,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS order_id BIGINT;

    -- How many times the refund retry job (see refundRetryJob.js) has tried and failed to
    -- refund this transaction with Mercado Pago -- caps retries so a permanently
    -- unrefundable payment (e.g. wrong payment method) doesn't get hammered forever.
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_attempts INT NOT NULL DEFAULT 0;

    -- Why the last refund attempt failed (see describeRefundError in mercadoPago.js): a
    -- short code for the admin panel, plus Mercado Pago's own message.
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_error_code VARCHAR(32);
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_last_error TEXT;

    -- A failed refund an admin closed by hand (see resolveFailedRefund): status becomes
    -- 'refunded_manually' (the money went back some other way) or 'refund_discarded'
    -- (nothing to give back, e.g. test data) -- who did it, when and why.
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_resolution_note TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_resolved_by VARCHAR(64);
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_resolved_at TIMESTAMPTZ;

    -- What an admin gave back by hand with a partial refund (pesos) -- the payment stays
    -- 'approved' until all of it went back.
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;

    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_transactions_external_reference ON transactions(external_reference);
    CREATE INDEX IF NOT EXISTS idx_transactions_order_id ON transactions(order_id);
  `;

  await pool.query(sql);
}

export async function saveTransaction(payment) {
  const paymentId = String(payment.id);
  const preferenceId = payment.order?.id ? String(payment.order.id) : null;
  const externalReference = payment.external_reference || null;
  const amount = Number(payment.transaction_amount || 0);
  const currency = payment.currency_id || 'ARS';
  const status = payment.status || 'unknown';
  const payerEmail = payment.payer?.email || null;
  const approvedAt = payment.date_approved || null;
  const metadata = payment.metadata || {};
  const orderId = metadata.order_id
    ? Number(metadata.order_id)
    : Array.isArray(metadata.order_ids) && metadata.order_ids.length > 0
      ? Number(metadata.order_ids[0])
      : null;

  const sql = `
    INSERT INTO transactions (
      payment_id,
      preference_id,
      external_reference,
      order_id,
      amount,
      currency,
      status,
      payer_email,
      raw_payload,
      approved_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, NOW())
    ON CONFLICT (payment_id)
    DO UPDATE SET
      preference_id = EXCLUDED.preference_id,
      external_reference = EXCLUDED.external_reference,
      order_id = EXCLUDED.order_id,
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      -- A refund we started locally outranks Mercado Pago still reporting the payment as
      -- approved (it does until the refund is processed) -- otherwise re-saving it would
      -- make it look refundable again.
      status = CASE
        WHEN transactions.status IN ('refunding', 'refunded', 'refund_failed', 'refunded_manually', 'refund_discarded')
          AND EXCLUDED.status = 'approved'
          THEN transactions.status
        ELSE EXCLUDED.status
      END,
      payer_email = EXCLUDED.payer_email,
      raw_payload = EXCLUDED.raw_payload,
      approved_at = EXCLUDED.approved_at,
      updated_at = NOW()
    RETURNING *;
  `;

  const values = [
    paymentId,
    preferenceId,
    externalReference,
    orderId,
    amount,
    currency,
    status,
    payerEmail,
    JSON.stringify(payment),
    approvedAt,
  ];

  const result = await pool.query(sql, values);
  return result.rows[0];
}

// Mantener compatibilidad con código existente
export async function saveApprovedTransaction(payment) {
  return saveTransaction(payment);
}

export async function getTransactionByPaymentId(paymentId) {
  const result = await pool.query('SELECT * FROM transactions WHERE payment_id = $1', [String(paymentId)]);
  return result.rows[0] || null;
}

export async function getTransactionByExternalReference(externalReference) {
  const result = await pool.query('SELECT * FROM transactions WHERE external_reference = $1 ORDER BY created_at DESC LIMIT 1', [
    String(externalReference),
  ]);
  return result.rows[0] || null;
}

export async function getTotalTransactionAmount() {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total_amount FROM transactions WHERE status = 'approved';`
  );
  return result.rows[0].total_amount;
}

export async function getTransactionAmountByPeriod(startDate, endDate) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total_amount
     FROM transactions
     WHERE status = 'approved' AND approved_at BETWEEN $1 AND $2;`,
    [startDate, endDate]
  );
  return result.rows[0].total_amount;
}

// Atomically claims an approved transaction for an automatic refund (status 'refunding'),
// so the webhook and the app's polling -- which can both see the same approval at the
// same time -- never both refund it. Resolves to true only for the caller that won.
export async function claimTransactionForRefund(paymentId) {
  const result = await pool.query(
    `
    UPDATE transactions
    SET
      status = 'refunding',
      updated_at = NOW()
    WHERE payment_id = $1
      AND status = 'approved'
    RETURNING payment_id
    `,
    [String(paymentId)]
  );
  return result.rowCount > 0;
}

export async function markTransactionAsRefundedByPaymentId(paymentId) {
  await pool.query(
    `
    UPDATE transactions
    SET
      status = 'refunded',
      updated_at = NOW()
    WHERE payment_id = $1
      AND status IN ('approved', 'refunding', 'refund_failed')
    `,
    [String(paymentId)]
  );
}

// A real Mercado Pago refund call failed (see /internal/refund-by-payment, and
// refundRetryJob.js's own retries) -- distinct from 'refunded' so the transaction shows
// up as needing follow-up instead of silently looking like the money went back.
// Bumps refund_attempts every time this is called, first failure included, so the retry
// job's cutoff (config.refundRetryMaxAttempts) counts every attempt, not just its own.
// `failure` is describeRefundError()'s result: saved for the admin panel, and a
// permanent one jumps straight to the cutoff -- retrying it could never work.
// Resolves to true when the transaction exists here (so the refund is tracked), false
// when there's nothing to flag.
export async function markTransactionAsRefundFailed(paymentId, failure = null, maxAttempts = 0) {
  const result = await pool.query(
    `
    UPDATE transactions
    SET
      status = 'refund_failed',
      refund_attempts = CASE WHEN $3 THEN GREATEST(refund_attempts + 1, $4) ELSE refund_attempts + 1 END,
      refund_error_code = $2,
      refund_last_error = $5,
      updated_at = NOW()
    WHERE payment_id = $1
    `,
    [String(paymentId), failure?.code ?? null, Boolean(failure?.permanent), maxAttempts, failure?.detail ?? null]
  );
  return result.rowCount > 0;
}

// Transactions still owing a refund, oldest-failed-first, that haven't already exhausted
// the retry budget -- what refundRetryJob.js works through on each tick.
export async function listRefundFailedTransactions(maxAttempts) {
  const result = await pool.query(
    `
    SELECT payment_id, refund_attempts
    FROM transactions
    WHERE status = 'refund_failed'
      AND refund_attempts < $1
    ORDER BY updated_at ASC
    `,
    [maxAttempts]
  );
  return result.rows;
}

// Every refund still owed, newest failure first -- the admin panel's "Reembolsos
// pendientes", including the ones the retry job already gave up on.
export async function listFailedRefunds() {
  const result = await pool.query(
    `
    SELECT payment_id, external_reference, amount, currency, payer_email, approved_at,
           refund_attempts, refund_error_code, refund_last_error, created_at, updated_at
    FROM transactions
    WHERE status = 'refund_failed'
    ORDER BY updated_at DESC
    `
  );
  return result.rows;
}

export async function countFailedRefunds() {
  const result = await pool.query(`SELECT COUNT(*)::int AS count FROM transactions WHERE status = 'refund_failed'`);
  return result.rows[0].count;
}

// Claims a failed refund for an admin's "retry now" (status 'refunding'), so it can't run
// at the same time as the retry job or another admin's click. True only for the winner.
export async function claimFailedRefundForRetry(paymentId) {
  const result = await pool.query(
    `
    UPDATE transactions
    SET status = 'refunding', updated_at = NOW()
    WHERE payment_id = $1 AND status = 'refund_failed'
    RETURNING payment_id
    `,
    [String(paymentId)]
  );
  return result.rowCount > 0;
}

// Closes a failed refund by hand: 'refunded_manually' (the money went back some other
// way, e.g. a bank transfer) or 'refund_discarded' (nothing to give back, e.g. test data).
// Resolves to the updated transaction, or null if it wasn't a failed refund (anymore).
export async function resolveFailedRefund(paymentId, status, note, adminId) {
  const result = await pool.query(
    `
    UPDATE transactions
    SET
      status = $2,
      refund_resolution_note = $3,
      refund_resolved_by = $4,
      refund_resolved_at = NOW(),
      updated_at = NOW()
    WHERE payment_id = $1 AND status = 'refund_failed'
    RETURNING *
    `,
    [String(paymentId), status, note, adminId]
  );
  return result.rows[0] || null;
}

// A partial refund went through: adds it to what was already given back.
export async function addPartialRefund(paymentId, amount) {
  await pool.query(
    `UPDATE transactions SET refunded_amount = refunded_amount + $2, updated_at = NOW() WHERE payment_id = $1`,
    [String(paymentId), amount]
  );
}

// Every payment, newest first, for the admin panel's "Pagos" screen. `status` filters by
// Mercado Pago's status; `query` matches a payment id, a booking id or the payer's email.
export async function listTransactions({ status, query, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const args = [];
  if (status) {
    args.push(status);
    conditions.push(`status = $${args.length}`);
  }
  if (query) {
    args.push(`%${String(query).trim().toLowerCase()}%`);
    conditions.push(
      `(LOWER(payment_id) LIKE $${args.length} OR LOWER(COALESCE(external_reference, '')) LIKE $${args.length} OR LOWER(COALESCE(payer_email, '')) LIKE $${args.length})`
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = await pool.query(`SELECT COUNT(*)::int AS count FROM transactions ${where}`, args);
  args.push(Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0));
  const rows = await pool.query(
    `SELECT payment_id, external_reference, amount, currency, status, payer_email, approved_at,
            refunded_amount, created_at, updated_at
     FROM transactions ${where}
     ORDER BY created_at DESC
     LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args
  );
  return { rows: rows.rows, total: total.rows[0].count };
}

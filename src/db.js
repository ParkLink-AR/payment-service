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
      status = EXCLUDED.status,
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

export async function markTransactionAsRefunded(orderId) {
  await pool.query(
    `
    UPDATE transactions
    SET
      status = 'refunded',
      updated_at = NOW()
    WHERE order_id = $1
      AND status = 'approved'
    `,
    [orderId]
  );
}

export async function markTransactionAsRefundedByPaymentId(paymentId) {
  await pool.query(
    `
    UPDATE transactions
    SET
      status = 'refunded',
      updated_at = NOW()
    WHERE payment_id = $1
      AND status = 'approved'
    `,
    [String(paymentId)]
  );
}

// A real Mercado Pago refund call failed (see /internal/refund-by-payment, and
// refundRetryJob.js's own retries) -- distinct from 'refunded' so the transaction shows
// up as needing manual follow-up instead of silently looking like the money went back.
// Bumps refund_attempts every time this is called, first failure included, so the retry
// job's cutoff (config.refundRetryMaxAttempts) counts every attempt, not just its own.
export async function markTransactionAsRefundFailed(paymentId) {
  await pool.query(
    `
    UPDATE transactions
    SET
      status = 'refund_failed',
      refund_attempts = refund_attempts + 1,
      updated_at = NOW()
    WHERE payment_id = $1
    `,
    [String(paymentId)]
  );
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

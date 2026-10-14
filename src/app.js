import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import {
  claimFailedRefundForRetry,
  claimTransactionForRefund,
  countFailedRefunds,
  getTransactionByExternalReference,
  getTransactionByPaymentId,
  pool,
  saveTransaction,
  listFailedRefunds,
  markTransactionAsRefundedByPaymentId,
  addPartialRefund,
  listTransactions,
  markTransactionAsRefundFailed,
  resolveFailedRefund,
} from './db.js';
import {
  createCheckoutPreference,
  describeRefundError,
  getPaymentById,
  refundPayment,
  searchPaymentByExternalReference,
} from './mercadoPago.js';
import { confirmBooking, getBooking } from './bookingClient.js';
import { getTotalTransactionAmount, getTransactionAmountByPeriod } from './db.js';
import { requireAdmin, requireInternalKey, requireGatewaySecret } from './security.js';
import { announceRefundCompleted } from './events.js';

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0] || '';
  }

  return typeof value === 'string' ? value : '';
}

function parseMercadoPagoSignature(signatureHeader) {
  if (!signatureHeader) {
    return null;
  }

  const signatureValues = {};

  for (const part of signatureHeader.split(',')) {
    const trimmedPart = part.trim();
    if (!trimmedPart) {
      continue;
    }

    const separatorIndex = trimmedPart.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedPart.slice(0, separatorIndex).trim();
    const value = trimmedPart.slice(separatorIndex + 1).trim();
    signatureValues[key] = value;
  }

  if (!signatureValues.ts || !signatureValues.v1) {
    return null;
  }

  return signatureValues;
}

function verifyMercadoPagoWebhookSignature(req) {
  const secret = config.mercadoPagoWebhookSecret;
  const signatureHeader = normalizeHeaderValue(req.headers['x-signature']);
  const requestId = normalizeHeaderValue(req.headers['x-request-id']);
  const paymentId = req.query['data.id'] || req.query.id || req.body?.data?.id || req.body?.id;

  if (!signatureHeader || !requestId || !paymentId) {
    return { ok: false, reason: 'missing signature headers or payment id' };
  }

  const parsedSignature = parseMercadoPagoSignature(signatureHeader);
  if (!parsedSignature) {
    return { ok: false, reason: 'invalid signature header format' };
  }

  const signedPayload = `id:${paymentId};request-id:${requestId};ts:${parsedSignature.ts};`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const receivedBuffer = Buffer.from(parsedSignature.v1, 'hex');

  if (expectedBuffer.length !== receivedBuffer.length) {
    return { ok: false, reason: 'signature length mismatch' };
  }

  if (!crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return { ok: false, reason: 'invalid signature' };
  }

  return { ok: true };
}

// booking-service error codes for an approved payment that can't pay for its booking
// (it arrived after the hold expired, charged the wrong amount, or the booking was
// already paid / isn't awaiting payment). The money moved, so it goes straight back.
const REFUNDABLE_CONFIRM_ERRORS = new Set(['HOLD_EXPIRED', 'AMOUNT_MISMATCH', 'BOOKING_NOT_PAYABLE']);

// A payment attempt that ended without charging: the driver can still pay the same booking
// with a new one while its hold lasts.
const RETRYABLE_PAYMENT_STATUSES = new Set(['rejected', 'cancelled']);

// Refunds an approved payment that has no booking to pay for. Claimed atomically first
// (see claimTransactionForRefund) so the webhook and the app's polling can't both refund
// it; a Mercado Pago failure is flagged refund_failed for refundRetryJob.js to retry.
async function refundUnbookablePayment(paymentId, reason) {
  if (!(await claimTransactionForRefund(paymentId))) {
    return;
  }
  try {
    await refundPayment(paymentId);
    await markTransactionAsRefundedByPaymentId(paymentId);
    console.warn(`[Payment] Refunded payment ${paymentId}: booking refused it (${reason})`);
  } catch (error) {
    console.error(`[Payment] Automatic refund of payment ${paymentId} failed, flagged for retry:`, error);
    await markTransactionAsRefundFailed(paymentId, describeRefundError(error), config.refundRetryMaxAttempts);
  }
}

// Confirms the booking in booking-service once its payment is approved. The bookingId
// travels as the payment's external_reference (set in /create-preference). Shared by the
// webhook handler, demo-pay, and verify-status's polling fallback -- booking-service's
// confirm is idempotent for the same payment, so calling this more than once for the
// same approval (webhook *and* a poll) is harmless. If booking-service refuses the payment
// outright, it's refunded.
async function confirmBookingIfApproved(payment) {
  if (!payment || payment.status !== 'approved') {
    return;
  }

  const bookingId = payment.external_reference;
  if (!bookingId) {
    return;
  }

  try {
    const amountCentavos = Math.round(Number(payment.transaction_amount || 0) * 100);
    const result = await confirmBooking(bookingId, payment.id, amountCentavos);
    if (result.ok) {
      console.log(`[Payment] Booking ${bookingId} confirmed with payment ${payment.id}`);
      return;
    }
    if (result.status === 400 && REFUNDABLE_CONFIRM_ERRORS.has(result.code)) {
      await refundUnbookablePayment(payment.id, result.code);
      return;
    }
    console.error(`[Payment] Booking confirmation failed: ${result.status} ${result.code ?? ''}`);
  } catch (confirmError) {
    console.error('[Payment] Error confirming booking:', confirmError.message);
  }
}

// The authenticated caller (set by the gateway) may act on bookingId's payment only if it's
// their own booking. Resolves to the booking, or sends the error response and resolves to
// null.
async function loadOwnBooking(req, res, bookingId) {
  if (!bookingId) {
    res.status(400).json({ message: 'externalReference is required' });
    return null;
  }
  const booking = await getBooking(bookingId);
  if (!booking) {
    res.status(404).json({ message: 'Booking not found' });
    return null;
  }
  const callerId = req.headers['x-user-id'];
  if (!callerId || callerId !== booking.user_id) {
    res.status(403).json({ message: 'Not your booking' });
    return null;
  }
  return booking;
}

export function createApp() {
  const app = express();
  app.use(
    cors({
      origin: config.corsOrigins === '*' ? '*' : config.corsOrigins.split(',').map((o) => o.trim()),
    }),
  );
  app.use(express.json());

  // Mercado Pago's hosted checkout only auto-redirects (auto_return) to a real
  // https:// URL, never to a custom app scheme like parklink:// -- so
  // create-preference points back_urls here instead of straight at the app's
  // deep link (see the auto_return check in mercadoPago.js). This bridge page
  // just bounces the browser to parklink://payment/pending, which is the only
  // screen that actually verifies the payment with us before showing a final
  // state -- so it's the target for every outcome, not just success, instead
  // of trusting Mercado Pago's own redirect status at face value.
  app.get('/payment-return', (req, res) => {
    const bookingId = req.query['external_reference'];
    console.log('[Payment Return] Mercado Pago redirected back:', {
      status: req.query.status,
      collectionStatus: req.query.collection_status,
      bookingId,
    });

    const deepLink = `parklink://payment/pending${bookingId ? `?bookingId=${encodeURIComponent(String(bookingId))}` : ''}`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0;url=${deepLink}" />
    <title>ParkLink</title>
  </head>
  <body style="font-family:sans-serif;text-align:center;padding-top:48px;">
    <p>Volviendo a ParkLink...</p>
    <a href="${deepLink}">Tocá acá si no volvés automáticamente</a>
    <script>location.replace(${JSON.stringify(deepLink)});</script>
  </body>
</html>`);
  });

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch (error) {
      console.error('[Payment Service] Health check failed:', error);
      res.status(500).json({ status: 'error' });
    }
  });

  // ── Demo payment endpoint ──────────────────────────────────────────────────
  // Instantly marks a booking as paid without going through MercadoPago.
  // Used for demos where the real payment gateway is unavailable. Gated
  // behind requireAdmin -- this isn't gateway-routed (not reachable from the
  // app), but payment-service is its own public Render service, so without
  // this anyone who found the URL could mark any booking "paid" for free.
  app.post('/api/payments/demo-pay', requireAdmin, async (req, res) => {
    try {
      const { bookingId, payerEmail } = req.body;

      if (!bookingId) {
        return res.status(400).json({ message: 'bookingId is required' });
      }
      const booking = await getBooking(bookingId);
      if (!booking) {
        return res.status(404).json({ message: 'Booking not found' });
      }

      const paymentId = `demo-${crypto.randomUUID()}`;
      const fakePayment = {
        id: paymentId,
        status: 'approved',
        transaction_amount: booking.amount / 100,
        currency_id: 'ARS',
        external_reference: bookingId,
        payer: { email: payerEmail || 'demo@pll.com' },
        date_approved: new Date().toISOString(),
        order: {},
        metadata: {},
      };

      const transaction = await saveTransaction(fakePayment);
      await confirmBookingIfApproved(fakePayment);

      return res.status(201).json({
        paymentId,
        status: 'approved',
        bookingId,
        transactionId: transaction.id,
      });
    } catch (error) {
      console.error('[Demo Pay] Error:', error);
      return res.status(500).json({ message: 'Demo payment error' });
    }
  });

  // The amount charged is always the booking's own server-side price (from
  // booking-service), never anything the client sends -- and only the booking's own driver
  // can open a checkout for it, while its hold is still running.
  app.post('/api/payments/create-preference', requireGatewaySecret, async (req, res) => {
    try {
      const booking = await loadOwnBooking(req, res, req.body?.externalReference);
      if (!booking) {
        return;
      }
      if (booking.status !== 'PENDING_PAYMENT') {
        return res.status(409).json({ code: 'BOOKING_NOT_PAYABLE', message: 'Booking is not awaiting payment' });
      }
      if (booking.hold_expires_at && new Date(booking.hold_expires_at) <= new Date()) {
        return res.status(409).json({ code: 'HOLD_EXPIRED', message: 'Booking hold has expired' });
      }

      const title = String(req.body?.title || 'Reserva ParkLink').slice(0, 120);
      const description = String(req.body?.description || 'Reserva de cochera en ParkLink').slice(0, 255);
      const forcedPayerEmail = config.forceTestPayerEmail?.trim();
      const payerEmail = forcedPayerEmail || req.body?.payerEmail || undefined;

      // See the /payment-return handler above for why this points here
      // instead of directly at the app's parklink:// deep link.
      const paymentReturnBase = (config.appBaseUrl || '').replace(/\/+$/, '');
      const backUrls = paymentReturnBase
        ? {
            success: `${paymentReturnBase}/payment-return?status=success`,
            failure: `${paymentReturnBase}/payment-return?status=failure`,
            pending: `${paymentReturnBase}/payment-return?status=pending`,
          }
        : undefined;

      const preference = await createCheckoutPreference({
        amount: booking.amount / 100,
        title,
        description,
        currency: config.defaultCurrency,
        payerEmail,
        externalReference: booking.id,
        backUrls,
        notificationUrl: `${config.webhookBaseUrl}/api/payments/webhook`,
        expiresAt: booking.hold_expires_at,
      });

      return res.status(201).json({
        preferenceId: preference.id,
        checkoutUrl: preference.init_point,
        externalReference: booking.id,
      });
    } catch (error) {
      console.error('[Payment Service] Error creating preference:', error);
      return res.status(500).json({ message: 'Error creating Mercado Pago preference' });
    }
  });

  app.post('/api/payments/webhook', async (req, res) => {
    try {
      if (config.skipWebhookSignature) {
        console.warn('[Payment Webhook] signature check skipped (MP_SKIP_WEBHOOK_SIGNATURE=true)');
      } else {
        const verification = verifyMercadoPagoWebhookSignature(req);
        if (!verification.ok) {
          console.warn(`[Payment Webhook] Signature verification failed: ${verification.reason}`);
          return res.status(403).json({ message: 'Forbidden' });
        }
      }

      const topic = req.query.topic || req.query.type || req.body?.type;
      const paymentId = req.query['data.id'] || req.query.id || req.body?.data?.id || req.body?.id;

      console.log('[Payment Webhook] Received verified webhook:', { topic, paymentId });

      if (!paymentId || (topic && topic !== 'payment')) {
        console.log('[Payment Webhook] Webhook ignored - invalid topic or missing paymentId');
        return res.status(200).json({ message: 'Webhook ignored' });
      }

      const payment = await getPaymentById(paymentId);
      const paymentStatus = payment.status;
      
      console.log(`[Payment Webhook] Processing payment ${paymentId} with status: ${paymentStatus}`);

      // Guardar la transacción independientemente del estado
      const transaction = await saveTransaction(payment);

      // El booking_id viaja en el external_reference (UUID que payment-service
      // genera en /create-preference y que la app adjunta al crear la preferencia).
      const bookingId = payment.external_reference || transaction.external_reference;
      await confirmBookingIfApproved(payment);

      return res.status(200).json({
        message: 'Webhook processed successfully',
        transactionId: transaction.id,
        paymentStatus: paymentStatus,
        bookingId: bookingId || null,
      });
    } catch (error) {
      console.error('[Payment Webhook] Error processing webhook:', error);
      return res.status(500).json({ message: 'Webhook processing error' });
    }
  });
  
  app.get('/api/payments/metrics', requireAdmin, async (req, res) => {
    try {
      const { from: startDate, to: endDate } = req.query;

      if (startDate && endDate) {
        const totalAmount = await getTransactionAmountByPeriod(startDate, endDate);
        return res.json({ totalAmount });
      }

      const totalAmount = await getTotalTransactionAmount();
      res.json({ totalAmount });
    } catch (error) {
      console.error('[Payment Service] Error fetching payment metrics:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });



  // Staff-only lookups (no ownership check of their own -- a transaction carries the
  // payer's email), not used by the app itself.
  app.get('/api/payments/:paymentId', requireAdmin, async (req, res) => {
    try {
      const transaction = await getTransactionByPaymentId(req.params.paymentId);
      if (!transaction) {
        return res.status(404).json({ message: 'Transaction not found' });
      }

      return res.json(transaction);
    } catch (error) {
      console.error('[Payment Service] Error fetching transaction:', error);
      return res.status(500).json({ message: 'Error fetching transaction' });
    }
  });

  app.get('/api/payments/external-reference/:externalReference', requireAdmin, async (req, res) => {
    try {
      const transaction = await getTransactionByExternalReference(req.params.externalReference);
      if (!transaction) {
        return res.status(404).json({ message: 'Transaction not found' });
      }

      return res.json(transaction);
    } catch (error) {
      console.error('[Payment Service] Error fetching transaction:', error);
      return res.status(500).json({ message: 'Error fetching transaction' });
    }
  });

  // The driver's app polls this after checkout (see mobile's payment/pending.tsx) with the
  // bookingId as externalReference -- only for their own booking. It deliberately takes no
  // client-supplied Mercado Pago payment id: the payment is always looked up by reference.
  app.post('/api/payments/verify-status', requireGatewaySecret, async (req, res) => {
    try {
      const externalReference = req.body?.externalReference;
      const booking = await loadOwnBooking(req, res, externalReference);
      if (!booking) {
        return;
      }

      let payment = null;
      let transaction = await getTransactionByExternalReference(externalReference);
      if (transaction) {
        payment = await getPaymentById(transaction.payment_id);
      }

      // Mobile's polling loop (pending.tsx) only ever has the bookingId
      // (externalReference), never MP's own paymentId -- it doesn't exist
      // yet on the client. Without this, verify-status could only find
      // anything once the webhook had already saved a transaction, which
      // never happens without a public WEBHOOK_BASE_URL (e.g. no ngrok in
      // local dev) -- the poll would 404 every time and time out at
      // "unknown" even though the payment actually went through on MP.
      if (!payment && !transaction && externalReference) {
        try {
          payment = await searchPaymentByExternalReference(externalReference);
          if (payment) {
            transaction = await saveTransaction(payment);
          }
        } catch (error) {
          console.log(`[Payment Verify] Search by externalReference ${externalReference} failed:`, error.message);
        }
      }

      // The driver can go back to the checkout and try again (e.g. after a declined card):
      // a newer attempt for the same booking may exist on Mercado Pago that the webhook
      // hasn't saved yet, and the old failed one mustn't hide it.
      if (transaction && RETRYABLE_PAYMENT_STATUSES.has(payment?.status || transaction.status)) {
        try {
          const latest = await searchPaymentByExternalReference(externalReference);
          if (latest && String(latest.id) !== String(transaction.payment_id)) {
            payment = latest;
            transaction = await saveTransaction(latest);
          }
        } catch (error) {
          console.log(`[Payment Verify] Search for a newer attempt on ${externalReference} failed:`, error.message);
        }
      }

      if (!transaction && !payment) {
        return res.status(404).json({ message: 'Payment not found', externalReference });
      }

      // Si el pago existe pero no está en nuestra DB, guardarlo
      if (payment && !transaction) {
        transaction = await saveTransaction(payment);
      }

      // This is the other half of not depending on the webhook: whichever
      // path found the payment above (DB, direct get, or the search
      // fallback), make sure the booking actually gets confirmed here too --
      // otherwise the client would see "approved" while the booking itself
      // stays PENDING_PAYMENT forever. Safe to call unconditionally: it's a
      // no-op if payment isn't approved, and a no-op if some other path
      // already confirmed this same booking.
      await confirmBookingIfApproved(payment);

      // Verificar si necesita reconciliación
      const currentStatus = payment?.status || transaction.status;
      const needsReconciliation = ['approved', 'rejected', 'cancelled', 'refunded'].includes(currentStatus);

      return res.json({
        transaction,
        currentStatus,
        needsReconciliation,
        message: needsReconciliation
          ? 'Payment status requires reconciliation with orders'
          : 'Payment status verified'
      });
    } catch (error) {
      console.error('[Payment Verify] Error:', error);
      return res.status(500).json({ message: 'Error verifying payment status' });
    }
  });

  // Where the driver's money stands for a booking that was cancelled after being paid
  // (driver cancelled, owner rejected or never answered) -- shown on the booking's own
  // screen. Read-only: unlike verify-status it never tries to confirm anything.
  app.get('/api/payments/refund-status/:bookingId', requireGatewaySecret, async (req, res) => {
    try {
      const booking = await loadOwnBooking(req, res, req.params.bookingId);
      if (!booking) {
        return;
      }
      const transaction = await getTransactionByExternalReference(booking.id);
      if (!transaction) {
        return res.json({ status: 'none' });
      }
      // A refund that failed every automatic retry (see refundRetryJob.js) is no longer
      // "in progress" -- it's waiting on someone from ParkLink, and the driver should know.
      const retriesExhausted =
        transaction.status === 'refund_failed' && Number(transaction.refund_attempts) >= config.refundRetryMaxAttempts;
      // Refunded by hand (outside Mercado Pago) counts as refunded; a discarded one (an
      // admin decided nothing is owed, e.g. test data) as no refund at all.
      const status =
        transaction.status === 'refunded' || transaction.status === 'refunded_manually'
          ? 'refunded'
          : retriesExhausted
            ? 'delayed'
            : ['approved', 'refunding', 'refund_failed'].includes(transaction.status)
              ? 'in_progress'
              : 'none';
      return res.json({
        status,
        amount: Number(transaction.amount),
        refundedAt: status === 'refunded' ? transaction.refund_resolved_at ?? transaction.updated_at : null,
      });
    } catch (error) {
      console.error('[Payment Service] Error fetching refund status:', error);
      return res.status(500).json({ message: 'Error fetching refund status' });
    }
  });

  // Triggered by booking-service whenever a paid booking is called off (the owner rejects
  // it or never answers, the driver cancels, an account closes, an admin refunds an
  // unverified stay) -- not gateway-routed, protected by a shared internal key instead of
  // a user's JWT (same "this port is directly reachable" reasoning as demo-pay above).
  app.post('/internal/refund-by-payment', requireInternalKey, async (req, res) => {
    try {
      const { payment_id, amount_centavos } = req.body;

      // An admin giving back only part of the payment (booking-service sends centavos).
      if (amount_centavos !== undefined && amount_centavos !== null) {
        const amount = Number(amount_centavos) / 100;
        if (!Number.isFinite(amount) || amount <= 0) {
          return res.status(400).json({ detail: 'amount_centavos must be positive' });
        }
        try {
          await refundPayment(payment_id, amount);
        } catch (error) {
          // Not queued for the retry job: it only knows how to refund a payment in full,
          // which would give back more than the admin decided. The admin sees the error and
          // tries again.
          console.error('[Payment] Mercado Pago partial refund failed:', error);
          return res.status(502).json({ success: false, detail: 'Mercado Pago rechazó el reembolso parcial.' });
        }
        await addPartialRefund(payment_id, amount);
        return res.json({ success: true, partial: true });
      }

      try {
        await refundPayment(payment_id);
      } catch (error) {
        // refundPayment() already no-ops for known-fake ids (mock-/seed-demo- prefixes,
        // see mercadoPago.js), so reaching here means a REAL payment failed to refund on
        // Mercado Pago's side -- marking it "refunded" anyway would be a lie the app and
        // support team would trust. It's flagged refund_failed instead: the retry job
        // tries again, and the admin panel lists it until someone resolves it.
        console.error('[Payment] Mercado Pago refund failed for a real payment, marking refund_failed:', error);
        const failure = describeRefundError(error);
        const tracked = await markTransactionAsRefundFailed(payment_id, failure, config.refundRetryMaxAttempts);
        if (tracked) {
          // 202: the refund is owed and on record -- the cancellation that asked for it
          // went through, so booking-service must not report it to its user as an error.
          return res.status(202).json({ success: false, queued: true, code: failure.code });
        }
        // No transaction here to flag: nobody would ever follow up on it.
        return res.status(502).json({
          success: false,
          detail: 'Mercado Pago refund failed and there is no transaction to flag for follow-up',
        });
      }

      await markTransactionAsRefundedByPaymentId(payment_id);

      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        detail: 'Failed to refund payment'
      });
    }
  });

  // -- Failed refunds, ParkLink-staff side (admin panel's "Reembolsos pendientes") --
  // Gateway-routed as /admin/refunds/* (ADMIN): every refund still owed to a driver, with
  // the booking it belongs to, and the ways to close one.

  // -- Every payment, ParkLink-staff side (admin panel's "Pagos") --
  // Each with the booking it paid for, flagging an approved payment whose booking never got
  // confirmed (a reconciliation problem staff need to look at).
  app.get('/admin/payments', requireAdmin, async (req, res) => {
    try {
      const { rows, total } = await listTransactions({
        status: req.query.status ? String(req.query.status) : undefined,
        query: req.query.q ? String(req.query.q) : undefined,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      const items = await Promise.all(
        rows.map(async (row) => {
          let booking = null;
          if (row.external_reference) {
            try {
              booking = await getBooking(row.external_reference);
            } catch (error) {
              console.warn(`[Payments] Could not load booking ${row.external_reference}:`, error.message);
            }
          }
          const bookingStatus = booking?.status ?? null;
          return {
            paymentId: row.payment_id,
            bookingId: row.external_reference,
            amount: Number(row.amount),
            refundedAmount: Number(row.refunded_amount),
            currency: row.currency,
            status: row.status,
            payerEmail: row.payer_email,
            approvedAt: row.approved_at,
            createdAt: row.created_at,
            bookingStatus,
            // Mercado Pago took the money but the booking isn't paid on our side.
            needsAttention:
              row.status === 'approved' && (!booking || ['PENDING_PAYMENT', 'EXPIRED'].includes(bookingStatus)),
          };
        })
      );
      return res.json({ items, total });
    } catch (error) {
      console.error('[Payments] Error listing payments:', error);
      return res.status(500).json({ detail: 'Error listing payments' });
    }
  });

  app.get('/admin/refunds/count', requireAdmin, async (_req, res) => {
    try {
      return res.json({ count: await countFailedRefunds() });
    } catch (error) {
      console.error('[Refunds] Error counting failed refunds:', error);
      return res.status(500).json({ detail: 'Error counting failed refunds' });
    }
  });

  app.get('/admin/refunds', requireAdmin, async (_req, res) => {
    try {
      const rows = await listFailedRefunds();
      // The booking each one paid for (whose it is, which spot, when) -- best effort: a
      // booking-service hiccup just leaves it out, the refund itself still shows.
      const items = await Promise.all(
        rows.map(async (row) => {
          let booking = null;
          if (row.external_reference) {
            try {
              booking = await getBooking(row.external_reference);
            } catch (error) {
              console.warn(`[Refunds] Could not load booking ${row.external_reference}:`, error.message);
            }
          }
          return {
            paymentId: row.payment_id,
            bookingId: row.external_reference,
            amount: Number(row.amount),
            currency: row.currency,
            payerEmail: row.payer_email,
            approvedAt: row.approved_at,
            attempts: Number(row.refund_attempts),
            retriesExhausted: Number(row.refund_attempts) >= config.refundRetryMaxAttempts,
            errorCode: row.refund_error_code,
            lastError: row.refund_last_error,
            failedAt: row.updated_at,
            booking,
          };
        }),
      );
      return res.json({ items });
    } catch (error) {
      console.error('[Refunds] Error listing failed refunds:', error);
      return res.status(500).json({ detail: 'Error listing failed refunds' });
    }
  });

  // "Reintentar": asks Mercado Pago again, right now.
  app.post('/admin/refunds/:paymentId/retry', requireAdmin, async (req, res) => {
    const { paymentId } = req.params;
    try {
      if (!(await claimFailedRefundForRetry(paymentId))) {
        return res.status(409).json({ code: 'NOT_PENDING', detail: 'Este reembolso ya no está pendiente.' });
      }
      try {
        await refundPayment(paymentId);
      } catch (error) {
        const failure = describeRefundError(error);
        console.error(`[Refunds] Manual retry of payment ${paymentId} failed:`, error);
        await markTransactionAsRefundFailed(paymentId, failure, config.refundRetryMaxAttempts);
        return res.status(502).json({ code: failure.code, detail: failure.detail });
      }
      await markTransactionAsRefundedByPaymentId(paymentId);
      console.log(`[Refunds] Payment ${paymentId} refunded on a manual retry by admin ${req.user?.sub}`);
      await announceRefundCompleted(paymentId, 'mercadopago');
      return res.json({ status: 'refunded' });
    } catch (error) {
      console.error('[Refunds] Error retrying refund:', error);
      return res.status(500).json({ detail: 'Error retrying refund' });
    }
  });

  // Closes one by hand: "refunded_manually" (the money went back some other way) or
  // "discarded" (nothing to give back, e.g. test data). A note is required to discard.
  const RESOLUTIONS = new Map([['refunded_manually', 'refunded_manually'], ['discarded', 'refund_discarded']]);
  app.post('/admin/refunds/:paymentId/resolve', requireAdmin, async (req, res) => {
    try {
      const status = RESOLUTIONS.get(String(req.body?.resolution ?? ''));
      if (!status) {
        return res.status(400).json({ code: 'INVALID_RESOLUTION', detail: 'resolution must be refunded_manually or discarded' });
      }
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 1000) : '';
      if (status === 'refund_discarded' && note.length < 3) {
        return res.status(400).json({ code: 'NOTE_REQUIRED', detail: 'Contá por qué se descarta este reembolso.' });
      }
      // Who closed it, as the panel shows people: the admin's username (from their token).
      const adminId = String(req.user?.admin_username || req.user?.sub || '');
      const resolved = await resolveFailedRefund(req.params.paymentId, status, note || null, adminId);
      if (!resolved) {
        return res.status(409).json({ code: 'NOT_PENDING', detail: 'Este reembolso ya no está pendiente.' });
      }
      console.log(`[Refunds] Payment ${req.params.paymentId} closed as ${status} by admin ${adminId}`);
      // Returned by hand: the driver is told. A discarded one (nothing owed) isn't.
      if (status === 'refunded_manually') await announceRefundCompleted(req.params.paymentId, 'manual');
      return res.json({ status: resolved.status });
    } catch (error) {
      console.error('[Refunds] Error resolving refund:', error);
      return res.status(500).json({ detail: 'Error resolving refund' });
    }
  });

  return app;
}

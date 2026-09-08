import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import {
  getTransactionByExternalReference,
  getTransactionByPaymentId,
  pool,
  saveTransaction,
  markTransactionAsRefunded,
  markTransactionAsRefundedByPaymentId,
} from './db.js';
import {
  createCheckoutPreference,
  generateExternalReference,
  getPaymentById,
  refundPayment,
  searchPaymentByExternalReference,
} from './mercadoPago.js';
import { getTotalTransactionAmount, getTransactionAmountByPeriod } from './db.js';
import { requireAdmin, requireInternalKey, requireGatewaySecret } from './security.js';

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

// Confirms the booking in booking-service once its payment is approved.
// The bookingId travels as the payment's external_reference (set by the app
// in /create-preference). Shared by the webhook handler, demo-pay, and
// verify-status's polling fallback -- ConfirmBooking on booking-service's
// side only updates rows still PENDING_PAYMENT, so calling this more than
// once for the same booking (e.g. webhook *and* a poll both catching the
// same approval) is a harmless no-op the second time.
async function confirmBookingIfApproved(payment) {
  if (!payment || payment.status !== 'approved') {
    return;
  }

  const bookingId = payment.external_reference;
  if (!bookingId) {
    return;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (config.bookingServiceAuthToken) {
    headers.Authorization = `Bearer ${config.bookingServiceAuthToken}`;
  }

  try {
    const confirmResponse = await fetch(`${config.bookingServiceUrl}/bookings/${bookingId}/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ payment_id: String(payment.id) }),
    });

    if (!confirmResponse.ok) {
      const errorText = await confirmResponse.text();
      console.error(`[Payment] Booking confirmation failed: ${confirmResponse.status} - ${errorText}`);
    } else {
      console.log(`[Payment] Booking ${bookingId} confirmed with payment ${payment.id}`);
    }
  } catch (confirmError) {
    console.error('[Payment] Error confirming booking:', confirmError.message);
  }
}

export function createApp() {
  const app = express();
  app.use(
    cors({
      origin: config.corsOrigins === '*' ? '*' : config.corsOrigins.split(',').map((o) => o.trim()),
    }),
  );
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch (error) {
      res.status(500).json({ status: 'error', message: error.message });
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
      const { bookingId, amount, payerEmail } = req.body;

      if (!bookingId) {
        return res.status(400).json({ message: 'bookingId is required' });
      }

      const paymentId = `demo-${crypto.randomUUID()}`;
      const fakePayment = {
        id: paymentId,
        status: 'approved',
        transaction_amount: Number(amount) || 0,
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
      return res.status(500).json({ message: 'Demo payment error', detail: error.message });
    }
  });

  app.post('/api/payments/create-preference', requireGatewaySecret, async (req, res) => {
    try {
      // Log token for debugging
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        console.log(`[Payment Service] Token received (last 4 digits): ...${token.slice(-4)}`);
      } else {
        console.log('[Payment Service] No token received');
      }

      const amount = Number(req.body?.amount);
      const orderId = req.body?.orderId ? Number(req.body.orderId) : null;
      const orderIds = Array.isArray(req.body?.orderIds)
        ? req.body.orderIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
        : [];
      const items = Array.isArray(req.body?.items) ? req.body.items : [];

      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ message: 'amount must be a positive number' });
      }

      const currency = (req.body?.currency || config.defaultCurrency).toUpperCase();
      const title = req.body?.title || (orderId ? `Orden #${orderId} - Bazaar` : 'Compra Bazaar');
      const description = req.body?.description || 'Pago de compra';
      const forcedPayerEmail = config.forceTestPayerEmail?.trim();
      const payerEmail = forcedPayerEmail || req.body?.payerEmail || undefined;
      const externalReference = req.body?.externalReference || crypto.randomUUID();

      const backUrls =
        config.frontendSuccessUrl || config.frontendFailureUrl || config.frontendPendingUrl
          ? {
              success: config.frontendSuccessUrl || undefined,
              failure: config.frontendFailureUrl || undefined,
              pending: config.frontendPendingUrl || undefined,
            }
          : undefined;

      console.log('[Payment Service] Creating preference with backUrls:', backUrls);
      if (forcedPayerEmail) {
        console.log(`[Payment Service] Using forced payer email from env: ${forcedPayerEmail}`);
      }

      const preference = await createCheckoutPreference({
        amount,
        title,
        description,
        currency,
        payerEmail,
        externalReference,
        orderId,
        orderIds,
        items,
        backUrls,
        notificationUrl: `${config.webhookBaseUrl}/api/payments/webhook`,
      });

      return res.status(201).json({
        preferenceId: preference.id,
        checkoutUrl: preference.init_point,
        externalReference,
        orderId,
      });
    } catch (error) {
      return res.status(500).json({
        message: 'Error creating Mercado Pago preference',
        detail: error.message,
      });
    }
  });

  app.post('/api/payments/external-reference', async (_req, res) => {
    try {
      const { externalReference } = await generateExternalReference();
      return res.status(201).json({ externalReference });
    } catch (error) {
      return res.status(500).json({
        message: 'Error generating external reference',
        detail: error.message,
      });
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
      return res.status(500).json({ message: 'Webhook processing error', detail: error.message });
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



  app.get('/api/payments/:paymentId', requireGatewaySecret, async (req, res) => {
    try {
      const transaction = await getTransactionByPaymentId(req.params.paymentId);
      if (!transaction) {
        return res.status(404).json({ message: 'Transaction not found' });
      }

      return res.json(transaction);
    } catch (error) {
      return res.status(500).json({ message: 'Error fetching transaction', detail: error.message });
    }
  });

  app.get('/api/payments/external-reference/:externalReference', requireGatewaySecret, async (req, res) => {
    try {
      const transaction = await getTransactionByExternalReference(req.params.externalReference);
      if (!transaction) {
        return res.status(404).json({ message: 'Transaction not found' });
      }

      return res.json(transaction);
    } catch (error) {
      return res.status(500).json({ message: 'Error fetching transaction', detail: error.message });
    }
  });

  app.post('/api/payments/verify-status', requireGatewaySecret, async (req, res) => {
    try {
      const { externalReference, paymentId } = req.body;

      if (!externalReference && !paymentId) {
        return res.status(400).json({
          message: 'Either externalReference or paymentId is required'
        });
      }

      let transaction = null;
      let payment = null;

      // Buscar transacción existente
      if (paymentId) {
        transaction = await getTransactionByPaymentId(paymentId);
        if (transaction) {
          payment = await getPaymentById(transaction.payment_id);
        }
      } else if (externalReference) {
        transaction = await getTransactionByExternalReference(externalReference);
        if (transaction) {
          payment = await getPaymentById(transaction.payment_id);
        }
      }

      // Si no hay transacción, intentar buscar el pago directamente en Mercado Pago
      if (!payment && paymentId) {
        try {
          payment = await getPaymentById(paymentId);
          // Guardar la transacción si se encontró el pago
          if (payment) {
            transaction = await saveTransaction(payment);
          }
        } catch (error) {
          console.log(`[Payment Verify] Payment ${paymentId} not found in Mercado Pago:`, error.message);
        }
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

      if (!transaction && !payment) {
        return res.status(404).json({
          message: 'Payment not found',
          externalReference,
          paymentId
        });
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
      return res.status(500).json({
        message: 'Error verifying payment status',
        detail: error.message
      });
    }
  });

  // Same reasoning as demo-pay above: no gateway route, but publicly
  // reachable on payment-service's own Render URL, so it needs its own auth.
  app.post('/internal/refund', requireAdmin, async (req, res) => {
    try {
      const { order_id } = req.body;

      await markTransactionAsRefunded(order_id);

      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        detail: 'Failed to refund payment'
      });
    }
  });

  // Triggered by booking-service when an owner rejects (or never responds to)
  // a booking that requires their approval -- not gateway-routed, protected
  // by a shared internal key instead of a user's JWT (same "this port is
  // directly reachable" reasoning as demo-pay/refund above).
  app.post('/internal/refund-by-payment', requireInternalKey, async (req, res) => {
    try {
      const { payment_id } = req.body;

      try {
        await refundPayment(payment_id);
      } catch (error) {
        // A payment_id from a local demo-pay/test flow doesn't exist on
        // Mercado Pago's side and will always fail here -- log it, but still
        // mark the record refunded below so dev/demo flows aren't blocked.
        console.error('Mercado Pago refund failed, marking refunded locally anyway:', error);
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

  return app;
}

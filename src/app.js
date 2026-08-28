import crypto from 'crypto';
import express from 'express';
import { config } from './config.js';
import { getTransactionByExternalReference, getTransactionByPaymentId, pool, saveTransaction, markTransactionAsRefunded } from './db.js';
import { createCheckoutPreference, generateExternalReference, getPaymentById } from './mercadoPago.js';
import { getTotalTransactionAmount, getTransactionAmountByPeriod } from './db.js';
import { requireAdmin } from './security.js';

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

export function createApp() {
  const app = express();
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
  // Used for demos where the real payment gateway is unavailable.
  app.post('/api/payments/demo-pay', async (req, res) => {
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

      // Confirm the booking in booking-service
      const headers = { 'Content-Type': 'application/json' };
      if (config.bookingServiceAuthToken) {
        headers.Authorization = `Bearer ${config.bookingServiceAuthToken}`;
      }

      try {
        const confirmResponse = await fetch(
          `${config.bookingServiceUrl}/bookings/${bookingId}/confirm`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ payment_id: paymentId }),
          }
        );

        if (!confirmResponse.ok) {
          const errorText = await confirmResponse.text();
          console.error(`[Demo Pay] Booking confirmation failed: ${confirmResponse.status} - ${errorText}`);
        } else {
          console.log(`[Demo Pay] Booking ${bookingId} confirmed with payment ${paymentId}`);
        }
      } catch (confirmError) {
        console.error('[Demo Pay] Error confirming booking:', confirmError.message);
      }

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

  app.post('/api/payments/create-preference', async (req, res) => {
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
      const verification = verifyMercadoPagoWebhookSignature(req);
      if (!verification.ok) {
        console.warn(`[Payment Webhook] Signature verification failed: ${verification.reason}`);
        return res.status(403).json({ message: 'Forbidden' });
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

      // Cuando el pago es aprobado, confirmar la reserva en booking-service.
      // El booking_id viaja en el external_reference (UUID que payment-service
      // genera en /create-preference y que la app adjunta al crear la preferencia).
      const bookingId = payment.external_reference || transaction.external_reference;

      if (paymentStatus === 'approved' && bookingId) {
        const headers = { 'Content-Type': 'application/json' };
        if (config.bookingServiceAuthToken) {
          headers.Authorization = `Bearer ${config.bookingServiceAuthToken}`;
        }

        try {
          const confirmResponse = await fetch(
            `${config.bookingServiceUrl}/bookings/${bookingId}/confirm`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({ payment_id: String(payment.id) }),
            }
          );

          if (!confirmResponse.ok) {
            const errorText = await confirmResponse.text();
            console.error(`[Payment Webhook] Booking confirmation failed: ${confirmResponse.status} - ${errorText}`);
          } else {
            console.log(`[Payment Webhook] Booking ${bookingId} confirmed with payment ${payment.id}`);
          }
        } catch (confirmError) {
          console.error('[Payment Webhook] Error confirming booking:', confirmError.message);
        }
      }

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



  app.get('/api/payments/:paymentId', async (req, res) => {
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

  app.get('/api/payments/external-reference/:externalReference', async (req, res) => {
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

  app.post('/api/payments/verify-status', async (req, res) => {
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

  app.post('/internal/refund', async (req, res) => {
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

  return app;
}

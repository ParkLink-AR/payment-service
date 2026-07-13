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

      const backUrls = {
        success: config.frontendSuccessUrl,
        failure: config.frontendFailureUrl,
        pending: config.frontendPendingUrl,
      };

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
      const externalReference = payment.external_reference || transaction.external_reference;

      // Definir estados que requieren reconciliación con order-service
      const APPROVED_STATUSES = ['approved'];
      const REJECTED_STATUSES = ['rejected', 'cancelled', 'refunded'];
      const PENDING_STATUSES = ['pending', 'in_process', 'in_mediation'];

      let shouldReconcile = false;
      let reconciliationStatus = paymentStatus;

      if (APPROVED_STATUSES.includes(paymentStatus)) {
        shouldReconcile = true;
        reconciliationStatus = 'approved';
        console.log(`[Payment Webhook] Payment approved - will reconcile as 'approved'`);
      } else if (REJECTED_STATUSES.includes(paymentStatus)) {
        shouldReconcile = true;
        reconciliationStatus = 'rejected';
        console.log(`[Payment Webhook] Payment rejected/cancelled - will reconcile as 'rejected'`);
      } else if (PENDING_STATUSES.includes(paymentStatus)) {
        shouldReconcile = true;
        reconciliationStatus = 'pending';
        console.log(`[Payment Webhook] Payment pending - will reconcile as 'pending'`);
      } else {
        console.log(`[Payment Webhook] Payment status '${paymentStatus}' - no reconciliation needed`);
      }

      if (shouldReconcile && externalReference) {
        const headers = {
          'Content-Type': 'application/json',
        };

        if (config.orderServiceAuthToken) {
          headers.Authorization = `Bearer ${config.orderServiceAuthToken}`;
        }

        try {
          const reconcileResponse = await fetch(`${config.orderServiceUrl}/api/v1/orders/payments/reconcile`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              payment_id: String(payment.id),
              preference_id: payment.order?.id ? String(payment.order.id) : null,
              external_reference: externalReference,
              status: reconciliationStatus,
            }),
          });

          if (!reconcileResponse.ok) {
            const errorText = await reconcileResponse.text();
            console.error(`[Payment Webhook] Order reconciliation failed: ${reconcileResponse.status} - ${errorText}`);
          } else {
            console.log(`[Payment Webhook] Order reconciled successfully with status: ${reconciliationStatus}`);
          }
        } catch (reconcileError) {
          console.error('[Payment Webhook] Error calling order reconciliation:', reconcileError.message);
        }
      }

      return res.status(200).json({
        message: 'Webhook processed successfully',
        transactionId: transaction.id,
        paymentStatus: paymentStatus,
        reconciliationStatus: shouldReconcile ? reconciliationStatus : null,
        externalReference: externalReference || null,
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

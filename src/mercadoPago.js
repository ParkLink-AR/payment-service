import { createRequire } from 'module';
import { MercadoPagoConfig, Payment, Preference } from 'mercadopago';
import { config } from './config.js';

// PaymentRefund isn't picked up by ESM named-export interop for this CJS
// package (unlike the classes above) -- inconsistently so between plain
// Node and Jest's --experimental-vm-modules. A plain require() sidesteps
// that static-analysis interop entirely.
const { PaymentRefund } = createRequire(import.meta.url)('mercadopago');

const client = new MercadoPagoConfig({
  accessToken: config.mercadoPagoAccessToken,
  options: { timeout: 10000 },
});

const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);
const refundClient = new PaymentRefund(client);

export async function createCheckoutPreference({
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
  notificationUrl,
}) {
  const preferenceItems = Array.isArray(items) && items.length > 0
    ? items.map((item) => ({
        title: item.title,
        description: item.description || item.title,
        quantity: Number(item.quantity || 1),
        unit_price: Number(item.unit_price),
        currency_id: item.currency_id || currency,
      }))
    : [
        {
          title,
          description,
          quantity: 1,
          unit_price: amount,
          currency_id: currency,
        },
      ];

  const normalizedBackUrls = backUrls
    ? {
        success: backUrls.success?.trim(),
        failure: backUrls.failure?.trim(),
        pending: backUrls.pending?.trim(),
      }
    : undefined;

  const normalizedNotificationUrl = notificationUrl
    ? notificationUrl.replace(/([^:]\/)\/+/, '$1')
    : undefined;

  // Mercado Pago rejects auto_return when success back_url is not HTTPS.
  const shouldUseAutoReturn =
    Boolean(normalizedBackUrls?.success) && normalizedBackUrls.success.startsWith('https://');

  const preferenceBody = {
    items: preferenceItems,
    payer: payerEmail ? { email: payerEmail } : undefined,
    external_reference: externalReference,
    metadata: orderIds?.length
      ? { order_ids: orderIds.map((value) => String(value)), order_id: orderId ? String(orderId) : undefined }
      : orderId
        ? { order_id: String(orderId) }
        : undefined,
    back_urls: normalizedBackUrls,
    auto_return: shouldUseAutoReturn ? 'approved' : undefined,
    notification_url: normalizedNotificationUrl,
  };

  console.log('[MercadoPago] Creating preference with body:', JSON.stringify(preferenceBody, null, 2));

  const response = await preferenceClient.create({
    body: preferenceBody,
  });

  return response;
}

export async function generateExternalReference() {
  return { externalReference: crypto.randomUUID() };
}

/**
 * Looks up the most recent payment for a given external_reference (the
 * bookingId) directly against Mercado Pago's Search API. Unlike getPaymentById
 * (which needs MP's own payment id), this only needs the reference the app
 * already has -- it's what lets /api/payments/verify-status resolve a
 * payment's status by polling, with no dependency on the webhook ever
 * reaching us (no ngrok/public URL required in local dev).
 */
export async function searchPaymentByExternalReference(externalReference) {
  const response = await paymentClient.search({
    options: { external_reference: externalReference, sort: 'date_created', criteria: 'desc' },
  });
  return response?.results?.[0] ?? null;
}

export async function getPaymentById(paymentId) {
  const idStr = String(paymentId);
  if (idStr.startsWith('mock-')) {
    // Formato: mock-status-orderId-amount-externalRef
    // Ejemplo: mock-approved-123-1500-ref123
    const parts = idStr.split('-');
    const status = parts[1] || 'approved';
    const orderId = parts[2] || '999';
    const amount = Number(parts[3] || '1000');
    const externalRef = parts.slice(4).join('-') || 'mock-ref';

    return {
      id: idStr,
      status: status,
      external_reference: externalRef,
      transaction_amount: amount,
      currency_id: 'ARS',
      order: { id: 'pref-' + orderId },
      payer: { email: 'mock_buyer@test.com' },
      date_approved: new Date().toISOString(),
      metadata: {
        order_id: String(orderId),
      },
    };
  }
  return paymentClient.get({ id: idStr });
}

// Full refund via Mercado Pago's real API. Payment ids created by demo-pay
// (see getPaymentById above) start with "mock-" and don't exist on Mercado
// Pago's side, so calling refund on them would always fail -- the caller
// (app.js) treats that as a no-op success instead of an error.
export async function refundPayment(paymentId) {
  const idStr = String(paymentId);
  if (idStr.startsWith('mock-')) {
    return { id: idStr, status: 'refunded', mocked: true };
  }
  return refundClient.create({ payment_id: idStr });
}


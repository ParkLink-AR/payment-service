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

// Payment types excluded from checkout: cash vouchers (Rapipago/Pago Fácil) and ATM
// transfers only get approved hours or days later -- long after the booking's hold has
// expired and the slot may belong to someone else.
const EXCLUDED_PAYMENT_TYPES = [{ id: 'ticket' }, { id: 'atm' }];

export async function createCheckoutPreference({
  amount,
  title,
  description,
  currency,
  payerEmail,
  externalReference,
  backUrls,
  notificationUrl,
  expiresAt,
}) {
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
    items: [{ title, description, quantity: 1, unit_price: amount, currency_id: currency }],
    payer: payerEmail ? { email: payerEmail } : undefined,
    external_reference: externalReference,
    back_urls: normalizedBackUrls,
    auto_return: shouldUseAutoReturn ? 'approved' : undefined,
    notification_url: normalizedNotificationUrl,
    // Approved or rejected right away -- never left "pending"/"in_process" to be
    // approved after the booking's hold is gone.
    binary_mode: true,
    payment_methods: { excluded_payment_types: EXCLUDED_PAYMENT_TYPES },
    // The checkout link stops working when the booking's hold does.
    ...(expiresAt ? { expires: true, expiration_date_to: new Date(expiresAt).toISOString() } : {}),
  };

  return preferenceClient.create({ body: preferenceBody });
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
  return paymentClient.get({ id: String(paymentId) });
}

// Full refund via Mercado Pago's real API. Payment ids created by demo-pay ("demo-"
// prefix) or by hand-seeded test data ("seed-demo-"/"mock-" prefixes) don't exist on
// Mercado Pago's side, so calling refund on them would always fail -- treated as a no-op
// success instead, so only a genuinely real payment's refund failure reaches the caller.
export async function refundPayment(paymentId) {
  const idStr = String(paymentId);
  if (idStr.startsWith('demo-') || idStr.startsWith('mock-') || idStr.startsWith('seed-demo-')) {
    return { id: idStr, status: 'refunded', mocked: true };
  }
  return refundClient.create({ payment_id: idStr });
}


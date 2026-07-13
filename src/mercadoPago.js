import { MercadoPagoConfig, Payment, Preference } from 'mercadopago';
import { config } from './config.js';

const client = new MercadoPagoConfig({
  accessToken: config.mercadoPagoAccessToken,
  options: { timeout: 10000 },
});

const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);

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


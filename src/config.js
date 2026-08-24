import dotenv from 'dotenv';

dotenv.config();

const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN || process.env.MP_ACCESS_TOKEN;
const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET || process.env.MERCADO_PAGO_WEBHOOK_SECRET;

const requiredEnv = [
  'DATABASE_URL',
  'JWT_SECRET'
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

if (!webhookSecret) {
  throw new Error('Missing required environment variable: MERCADOPAGO_WEBHOOK_SECRET (or MERCADO_PAGO_WEBHOOK_SECRET)');
}

if (!accessToken) {
  throw new Error('Missing required environment variable: MERCADOPAGO_ACCESS_TOKEN (or MP_ACCESS_TOKEN)');
}

/* // Common misconfiguration: frontend/public key pasted into backend token variable.
if (/^APP_USR-[0-9a-fA-F-]{36}$/.test(accessToken)) {
  throw new Error(
    'Invalid Mercado Pago Access Token: value looks like a Public Key (APP_USR-UUID). Use a backend Access Token from Mercado Pago Developers.'
  );
} */

export const config = {
  port: Number(process.env.PORT || 8004),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  mercadoPagoAccessToken: accessToken,
  forceTestPayerEmail: process.env.MP_FORCE_TEST_PAYER_EMAIL || '',
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:8004',
  webhookBaseUrl: process.env.WEBHOOK_BASE_URL || process.env.APP_BASE_URL || 'http://localhost:8004',
  frontendSuccessUrl: process.env.FRONTEND_SUCCESS_URL || 'http://localhost:19006/payment/success',
  frontendFailureUrl: process.env.FRONTEND_FAILURE_URL || 'http://localhost:19006/payment/failure',
  frontendPendingUrl: process.env.FRONTEND_PENDING_URL || 'http://localhost:19006/payment/pending',
  defaultCurrency: process.env.DEFAULT_CURRENCY || 'ARS',
  bookingServiceUrl: process.env.BOOKING_SERVICE_URL || 'http://localhost:8080',
  bookingServiceAuthToken: process.env.BOOKING_SERVICE_AUTH_TOKEN || '',
  mercadoPagoWebhookSecret: webhookSecret,
};

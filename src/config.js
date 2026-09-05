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

const isProd = (process.env.ENVIRONMENT || process.env.NODE_ENV) === 'production';
const insecureSubstrings = ['dev-secret', 'change-me', 'reemplazar', 'secret123', 'password', '123456'];

if (isProd) {
  const jwtSec = (process.env.JWT_SECRET || '').toLowerCase();
  if (jwtSec.length < 32 || insecureSubstrings.some((s) => jwtSec.includes(s))) {
    throw new Error('FATAL: Insecure or default JWT_SECRET configured in production environment.');
  }
  const intKey = (process.env.INTERNAL_SERVICE_KEY || '').toLowerCase();
  if (intKey.length < 32 || insecureSubstrings.some((s) => intKey.includes(s))) {
    throw new Error('FATAL: Insecure or default INTERNAL_SERVICE_KEY configured in production environment.');
  }
  if (process.env.MP_SKIP_WEBHOOK_SIGNATURE === 'true') {
    throw new Error('FATAL: MP_SKIP_WEBHOOK_SIGNATURE cannot be true in production.');
  }
}

// MercadoPago credentials are optional when running in demo mode
if (!webhookSecret) {
  console.warn('[Config] MERCADOPAGO_WEBHOOK_SECRET not set — MercadoPago webhook verification disabled (demo mode).');
}

if (!accessToken) {
  console.warn('[Config] MERCADOPAGO_ACCESS_TOKEN not set — MercadoPago checkout disabled (demo mode).');
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
  frontendSuccessUrl: process.env.FRONTEND_SUCCESS_URL || '',
  frontendFailureUrl: process.env.FRONTEND_FAILURE_URL || '',
  frontendPendingUrl: process.env.FRONTEND_PENDING_URL || '',
  defaultCurrency: process.env.DEFAULT_CURRENCY || 'ARS',
  bookingServiceUrl: process.env.BOOKING_SERVICE_URL || 'http://localhost:8080',
  bookingServiceAuthToken: process.env.BOOKING_SERVICE_AUTH_TOKEN || '',
  mercadoPagoWebhookSecret: webhookSecret,
  // Local/dev escape hatch: skip HMAC verification of the Mercado Pago webhook.
  // Useful when tunnelling the webhook to a laptop and the secret/signature
  // don't line up. NEVER set this in a real deployment.
  skipWebhookSignature: process.env.MP_SKIP_WEBHOOK_SIGNATURE === 'true',
  // admin-dashboard fetches /api/payments/metrics directly (not through the
  // gateway), so this service needs its own CORS allowlist. Same default as
  // gateway's own CORS_ORIGINS -- tighten in production via env.
  corsOrigins: process.env.CORS_ORIGINS || '*',
};

if (config.skipWebhookSignature) {
  console.warn('[Config] MP_SKIP_WEBHOOK_SIGNATURE=true — Mercado Pago webhook signature verification is DISABLED. Dev only.');
}

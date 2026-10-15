import * as Sentry from '@sentry/node';

// Error reports to Sentry. Without SENTRY_DSN it stays off (development, tests): nothing is
// sent.
const dsn = process.env.SENTRY_DSN;

export function initMonitoring() {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || 'production',
    serverName: 'payment-service',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    initialScope: { tags: { service: 'payment-service' } },
  });
}

/** Reports an error a route caught and answered with a 5xx. */
export function reportError(error) {
  if (dsn) Sentry.captureException(error);
}

import { initMonitoring } from './monitoring.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { initDatabase } from './db.js';
import { startRefundRetryJob } from './refundRetryJob.js';

initMonitoring();

async function bootstrap() {
  await initDatabase();
  const app = createApp();

  app.listen(config.port, () => {
    console.log(`payment-service listening on port ${config.port}`);
  });

  // Background job: retry refunds that previously failed against Mercado Pago instead of
  // leaving them stuck on "needs manual review" forever.
  startRefundRetryJob();
}

bootstrap().catch((error) => {
  console.error('Failed to start payment-service', error);
  process.exit(1);
});

import { createApp } from './app.js';
import { config } from './config.js';
import { initDatabase } from './db.js';

async function bootstrap() {
  await initDatabase();
  const app = createApp();

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`payment-service listening on port ${config.port}`);
  });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start payment-service', error);
  process.exit(1);
});

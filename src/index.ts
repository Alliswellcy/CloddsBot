/**
 * Clodds - AI Assistant for Prediction Markets
 * Claude + Odds
 *
 * Entry point - starts the gateway and all services
 */

import 'dotenv/config';
import { createGateway } from './gateway/index';
import { loadConfig } from './utils/config';
import { logger } from './utils/logger';
import { installHttpClient, configureHttpClient } from './utils/http';

async function main() {
  logger.info('Starting Clodds...');
  installHttpClient();

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.error({ error }, 'Uncaught exception');
    process.exit(1);
  });

  // Load configuration
  const config = await loadConfig();
  configureHttpClient(config.http);
  logger.info({ port: config.gateway.port }, 'Config loaded');

  // Create and start gateway
  const gateway = await createGateway(config);
  await gateway.start();

  logger.info('Clodds is running!');

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await gateway.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});

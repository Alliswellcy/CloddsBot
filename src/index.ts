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

/**
 * Validate required environment variables and configuration
 * Provides clear error messages for common setup issues
 */
function validateStartupRequirements(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for Anthropic API key (required for AI functionality)
  if (!process.env.ANTHROPIC_API_KEY) {
    errors.push(
      'ANTHROPIC_API_KEY is not set. The AI agent will not function.\n' +
      '  Fix: Add ANTHROPIC_API_KEY=sk-ant-... to your .env file\n' +
      '  Or run: clodds onboard'
    );
  }

  // Check for common channel configurations (warnings only)
  if (!process.env.TELEGRAM_BOT_TOKEN && !process.env.DISCORD_BOT_TOKEN) {
    warnings.push(
      'No messaging channel configured (TELEGRAM_BOT_TOKEN or DISCORD_BOT_TOKEN).\n' +
      '  WebChat at http://localhost:18789/webchat will still work.'
    );
  }

  // Log warnings
  for (const warning of warnings) {
    logger.warn(warning);
  }

  // Exit with errors if critical requirements missing
  if (errors.length > 0) {
    console.error('\n=== Clodds Startup Failed ===\n');
    for (const error of errors) {
      console.error(`ERROR: ${error}\n`);
    }
    console.error('Run "clodds doctor" for full diagnostics.\n');
    process.exit(1);
  }
}

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

  // Validate startup requirements before loading config
  validateStartupRequirements();

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

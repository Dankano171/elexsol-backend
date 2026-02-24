// src/index.ts
import 'dotenv/config';
import { createServer } from 'http';
import app from './app';
import { initializeDatabase } from './config/database';
import { initializeRedis } from './config/redis';
import { initializeQueues } from './lib/queue/queue.config';
import { logger } from './config/logger';
import { startSchedulers } from './jobs';

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  try {
    // Initialize database connection
    await initializeDatabase();
    logger.info('✅ Database connected successfully');

    // Initialize Redis
    await initializeRedis();
    logger.info('✅ Redis connected successfully');

    // Initialize BullMQ queues
    await initializeQueues();
    logger.info('✅ Queues initialized successfully');

    // Start background schedulers
    startSchedulers();
    logger.info('✅ Background jobs started');

    // Create HTTP server
    const server = createServer(app);

    // Graceful shutdown
    const gracefulShutdown = async () => {
      logger.info('Received shutdown signal, closing connections...');
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

    // Start server
    server.listen(PORT, () => {
      logger.info(`🚀 Elexsol Gateway running on port ${PORT}`);
      logger.info(`📊 Admin hub: /admin-hidden-route`);
      logger.info(`🔗 Webhook endpoint: /webhook`);
    });

  } catch (error) {
    logger.error('❌ Failed to bootstrap application:', error);
    process.exit(1);
  }
}

bootstrap();

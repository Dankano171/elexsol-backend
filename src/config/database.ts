import { Pool, PoolClient, PoolConfig } from 'pg';
import { logger } from './logger';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  maxConnections: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

class Database {
  private static instance: Database;
  private pool: Pool;
  private config: DatabaseConfig;

  private constructor() {
    this.config = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'elexsol',
      user: process.env.DB_USER || 'elexsol_admin',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_SSL === 'true',
      maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS || '20'),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    };

    const poolConfig: PoolConfig = {
      ...this.config,
      max: this.config.maxConnections,
      idleTimeoutMillis: this.config.idleTimeoutMillis,
      connectionTimeoutMillis: this.config.connectionTimeoutMillis,
    };

    if (this.config.ssl) {
      poolConfig.ssl = {
        rejectUnauthorized: false
      };
    }

    this.pool = new Pool(poolConfig);

    this.pool.on('connect', (client) => {
      logger.debug('New database client connected');
    });

    this.pool.on('error', (err, client) => {
      logger.error('Unexpected database error:', err);
      if (client) {
        client.release(true); // Force release on error
      }
    });

    this.pool.on('remove', (client) => {
      logger.debug('Database client removed');
    });
  }

  public static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  public async getPool(): Promise<Pool> {
    // Test connection if pool is not ready
    try {
      await this.pool.query('SELECT 1');
    } catch (error) {
      logger.error('Database connection test failed:', error);
      throw error;
    }
    return this.pool;
  }

  public async getClient(): Promise<PoolClient> {
    const client = await this.pool.connect();
    return client;
  }

  public async executeInTransaction<T>(
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async healthCheck(): Promise<boolean> {
    try {
      const client = await this.getClient();
      const result = await client.query('SELECT 1 as health');
      client.release();
      return result.rows[0]?.health === 1;
    } catch (error) {
      logger.error('Database health check failed:', error);
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
    logger.info('Database pool closed');
  }

  public getConfig(): DatabaseConfig {
    return { ...this.config };
  }
}

export const db = Database.getInstance();
export const initializeDatabase = async (): Promise<void> => {
  await db.getPool();
  logger.info('✅ Database initialized successfully');
};

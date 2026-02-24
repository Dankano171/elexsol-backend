import { BaseModel, BaseEntity } from './BaseModel';
import { db } from '../config/database';
import { logger } from '../config/logger';

export interface WebhookEvent extends BaseEntity {
  webhook_id: string;
  integration_id?: string;
  business_id?: string;
  provider: string;
  event_type: string;
  payload: Record<string, any>;
  headers: Record<string, any>;
  ip?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'ignored';
  attempts: number;
  max_attempts: number;
  next_retry_at?: Date;
  last_error?: string;
  response_code?: number;
  response_body?: string;
  processed_at?: Date;
  completed_at?: Date;
  metadata: Record<string, any>;
}

export interface CreateWebhookEventDTO {
  webhook_id: string;
  integration_id?: string;
  business_id?: string;
  provider: string;
  event_type: string;
  payload: Record<string, any>;
  headers: Record<string, any>;
  ip?: string;
  metadata?: Record<string, any>;
}

export class WebhookEventModel extends BaseModel<WebhookEvent> {
  protected tableName = 'webhook_events';
  protected primaryKey = 'id';

  /**
   * Create webhook event
   */
  async createEvent(data: CreateWebhookEventDTO): Promise<WebhookEvent> {
    return this.create({
      ...data,
      status: 'pending',
      attempts: 0,
      max_attempts: 3,
      metadata: data.metadata || {},
    });
  }

  /**
   * Get pending webhooks for processing
   */
  async getPendingForProcessing(limit: number = 10): Promise<WebhookEvent[]> {
    const query = `
      SELECT * FROM webhook_events
      WHERE status IN ('pending', 'failed')
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        AND attempts < max_attempts
        AND deleted_at IS NULL
      ORDER BY 
        CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
        created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `;

    const result = await db.query(query, [limit]);
    return result.rows;
  }

  /**
   * Mark as processing
   */
  async markProcessing(id: string): Promise<void> {
    await this.update(id, {
      status: 'processing',
      attempts: db.raw('attempts + 1'),
    });
  }

  /**
   * Mark as completed
   */
  async markCompleted(
    id: string,
    responseCode?: number,
    responseBody?: string
  ): Promise<void> {
    await this.update(id, {
      status: 'completed',
      response_code: responseCode,
      response_body: responseBody,
      processed_at: new Date(),
      completed_at: new Date(),
    });
  }

  /**
   * Mark as failed
   */
  async markFailed(
    id: string,
    error: string,
    retryDelayMinutes: number = 5
  ): Promise<void> {
    const event = await this.findById(id);
    
    if (!event) {
      return;
    }

    const nextRetryAt = new Date();
    nextRetryAt.setMinutes(nextRetryAt.getMinutes() + retryDelayMinutes);

    const updates: Partial<WebhookEvent> = {
      status: event.attempts >= event.max_attempts ? 'failed' : 'pending',
      last_error: error,
      processed_at: new Date(),
    };

    if (event.attempts < event.max_attempts) {
      updates.next_retry_at = nextRetryAt;
    }

    await this.update(id, updates);
  }

  /**
   * Mark as ignored
   */
  async markIgnored(id: string, reason: string): Promise<void> {
    await this.update(id, {
      status: 'ignored',
      last_error: reason,
      processed_at: new Date(),
      completed_at: new Date(),
    });
  }

  /**
   * Get events by integration
   */
  async getByIntegration(
    integrationId: string,
    options?: {
      status?: WebhookEvent['status'];
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ events: WebhookEvent[]; total: number }> {
    let sql = 'SELECT * FROM webhook_events WHERE integration_id = $1 AND deleted_at IS NULL';
    const countSql = 'SELECT COUNT(*) FROM webhook_events WHERE integration_id = $1 AND deleted_at IS NULL';
    const conditions: string[] = [];
    const params: any[] = [integrationId];
    let paramIndex = 2;

    if (options?.status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(options.status);
      paramIndex++;
    }

    if (options?.fromDate) {
      conditions.push(`created_at >= $${paramIndex}`);
      params.push(options.fromDate);
      paramIndex++;
    }

    if (options?.toDate) {
      conditions.push(`created_at <= $${paramIndex}`);
      params.push(options.toDate);
      paramIndex++;
    }

    if (conditions.length > 0) {
      const whereClause = ' AND ' + conditions.join(' AND ');
      sql += whereClause;
    }

    sql += ` ORDER BY created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    
    const limit = options?.limit || 20;
    const offset = options?.offset || 0;
    params.push(limit, offset);

    const [events, countResult] = await Promise.all([
      db.query(sql, params),
      db.query(countSql, [integrationId]),
    ]);

    return {
      events: events.rows,
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * Get events by business
   */
  async getByBusiness(
    businessId: string,
    options?: {
      provider?: string;
      status?: WebhookEvent['status'];
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ events: WebhookEvent[]; total: number }> {
    let sql = 'SELECT * FROM webhook_events WHERE business_id = $1 AND deleted_at IS NULL';
    const countSql = 'SELECT COUNT(*) FROM webhook_events WHERE business_id = $1 AND deleted_at IS NULL';
    const conditions: string[] = [];
    const params: any[] = [businessId];
    let paramIndex = 2;

    if (options?.provider) {
      conditions.push(`provider = $${paramIndex}`);
      params.push(options.provider);
      paramIndex++;
    }

    if (options?.status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(options.status);
      paramIndex++;
    }

    if (options?.fromDate) {
      conditions.push(`created_at >= $${paramIndex}`);
      params.push(options.fromDate);
      paramIndex++;
    }

    if (options?.toDate) {
      conditions.push(`created_at <= $${paramIndex}`);
      params.push(options.toDate);
      paramIndex++;
    }

    if (conditions.length > 0) {
      const whereClause = ' AND ' + conditions.join(' AND ');
      sql += whereClause;
    }

    sql += ` ORDER BY created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    
    const limit = options?.limit || 20;
    const offset = options?.offset || 0;
    params.push(limit, offset);

    const [events, countResult] = await Promise.all([
      db.query(sql, params),
      db.query(countSql, [businessId]),
    ]);

    return {
      events: events.rows,
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * Get webhook statistics
   */
  async getStatistics(
    businessId?: string,
    integrationId?: string,
    fromDate?: Date,
    toDate?: Date
  ): Promise<any> {
    let whereConditions: string[] = ['deleted_at IS NULL'];
    const params: any[] = [];
    let paramIndex = 1;

    if (businessId) {
      whereConditions.push(`business_id = $${paramIndex}`);
      params.push(businessId);
      paramIndex++;
    }

    if (integrationId) {
      whereConditions.push(`integration_id = $${paramIndex}`);
      params.push(integrationId);
      paramIndex++;
    }

    if (fromDate) {
      whereConditions.push(`created_at >= $${paramIndex}`);
      params.push(fromDate);
      paramIndex++;
    }

    if (toDate) {
      whereConditions.push(`created_at <= $${paramIndex}`);
      params.push(toDate);
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0 
      ? 'WHERE ' + whereConditions.join(' AND ')
      : '';

    const query = `
      SELECT
        provider,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        AVG(CASE WHEN status = 'completed' 
            THEN EXTRACT(EPOCH FROM (completed_at - created_at)) 
            ELSE NULL END) as avg_processing_time,
        MAX(attempts) as max_attempts,
        DATE(created_at) as date
      FROM webhook_events
      ${whereClause}
      GROUP BY provider, DATE(created_at)
      ORDER BY date DESC
    `;

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Get failed webhooks needing retry
   */
  async getFailedForRetry(limit: number = 10): Promise<WebhookEvent[]> {
    const query = `
      SELECT * FROM webhook_events
      WHERE status = 'failed'
        AND attempts < max_attempts
        AND next_retry_at <= NOW()
        AND deleted_at IS NULL
      ORDER BY next_retry_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `;

    const result = await db.query(query, [limit]);
    return result.rows;
  }

  /**
   * Clean up old webhook events
   */
  async cleanupOldEvents(daysToKeep: number = 30): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);

    const query = `
      DELETE FROM webhook_events
      WHERE created_at < $1
        AND status IN ('completed', 'ignored', 'failed')
    `;

    const result = await db.query(query, [cutoff]);
    return result.rowCount || 0;
  }

  /**
   * Get webhook delivery metrics
   */
  async getDeliveryMetrics(
    integrationId: string,
    hours: number = 24
  ): Promise<any> {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - hours);

    const query = `
      SELECT
        COUNT(*) as total_deliveries,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        AVG(CASE WHEN status = 'completed' 
            THEN EXTRACT(EPOCH FROM (completed_at - created_at)) 
            ELSE NULL END) as avg_latency_seconds,
        MAX(CASE WHEN status = 'failed' THEN attempts ELSE 0 END) as max_retries
      FROM webhook_events
      WHERE integration_id = $1
        AND created_at >= $2
    `;

    const result = await db.query(query, [integrationId, cutoff]);
    return result.rows[0];
  }
}

export const webhookEventModel = new WebhookEventModel();

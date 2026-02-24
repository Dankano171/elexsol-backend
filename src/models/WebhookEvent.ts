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
  async markProcessing(id: string):

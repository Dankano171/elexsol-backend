import { BaseModel, BaseEntity } from './BaseModel';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { NotificationType, NotificationPriority, NotificationChannel } from '../config/constants/business-rules';

export interface NotificationDigest extends BaseEntity {
  business_id: string;
  user_id?: string;
  type: NotificationType;
  title: string;
  summary?: string;
  items: Array<{
    id: string;
    type: string;
    title: string;
    description: string;
    action_url?: string;
    action_label?: string;
    metadata: Record<string, any>;
    created_at: Date;
  }>;
  priority: NotificationPriority;
  channels: NotificationChannel[];
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  sent_at?: Date;
  sent_via?: Record<NotificationChannel, { status: string; error?: string }>;
  scheduled_for?: Date;
  expires_at?: Date;
  metadata: Record<string, any>;
  created_by?: string;
}

export interface CreateDigestDTO {
  business_id: string;
  user_id?: string;
  type: NotificationType;
  title: string;
  summary?: string;
  items?: NotificationDigest['items'];
  priority?: NotificationPriority;
  channels?: NotificationChannel[];
  scheduled_for?: Date;
  expires_at?: Date;
  metadata?: Record<string, any>;
}

export class NotificationDigestModel extends BaseModel<NotificationDigest> {
  protected tableName = 'notification_digests';
  protected primaryKey = 'id';

  /**
   * Create a new digest
   */
  async createDigest(data: CreateDigestDTO, createdBy?: string): Promise<NotificationDigest> {
    // Get user notification preferences
    let channels = data.channels;
    let priority = data.priority;

    if (data.user_id && !channels) {
      const userPrefs = await db.query(
        `SELECT notification_preferences FROM users WHERE id = $1`,
        [data.user_id]
      );

      if (userPrefs.rows[0]?.notification_preferences) {
        const prefs = userPrefs.rows[0].notification_preferences;
        channels = [];
        if (prefs.email) channels.push('email');
        if (prefs.sms) channels.push('sms');
        if (prefs.push) channels.push('push');
      }
    }

    if (!priority) {
      // Set priority based on type
      const priorityMap: Record<NotificationType, NotificationPriority> = {
        success: 'low',
        action_required: 'high',
        integration: 'medium',
        regulatory: 'medium',
      };
      priority = priorityMap[data.type] || 'medium';
    }

    return this.create({
      business_id: data.business_id,
      user_id: data.user_id,
      type: data.type,
      title: data.title,
      summary: data.summary,
      items: data.items || [],
      priority,
      channels: channels || ['email'],
      status: 'pending',
      scheduled_for: data.scheduled_for,
      expires_at: data.expires_at,
      metadata: data.metadata || {},
      created_by: createdBy,
    });
  }

  /**
   * Add item to digest
   */
  async addItem(
    digestId: string,
    item: NotificationDigest['items'][0]
  ): Promise<void> {
    const digest = await this.findById(digestId);
    
    if (!digest) {
      throw new Error('Digest not found');
    }

    if (digest.status !== 'pending') {
      throw new Error(`Cannot add items to ${digest.status} digest`);
    }

    const items = [...digest.items, item];
    
    await this.update(digestId, { items });
  }

  /**
   * Get pending digests for sending
   */
  async getPendingForSending(limit: number = 50): Promise<NotificationDigest[]> {
    const query = `
      SELECT * FROM notification_digests
      WHERE status = 'pending'
        AND (scheduled_for IS NULL OR scheduled_for <= NOW())
        AND (expires_at IS NULL OR expires_at > NOW())
        AND deleted_at IS NULL
      ORDER BY 
        CASE priority
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
        END,
        created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `;

    const result = await db.query(query, [limit]);
    return result.rows;
  }

  /**
   * Mark as sent
   */
  async markAsSent(
    id: string,
    sentVia: Record<NotificationChannel, { status: string; error?: string }>
  ): Promise<void> {
    await this.update(id, {
      status: 'sent',
      sent_at: new Date(),
      sent_via: sentVia,
    });
  }

  /**
   * Mark as failed
   */
  async markAsFailed(id: string, error: string): Promise<void> {
    await this.update(id, {
      status: 'failed',
      metadata: {
        ...(await this.findById(id))?.metadata,
        error,
        failed_at: new Date(),
      },
    });
  }

  /**
   * Cancel digest
   */
  async cancel(id: string, reason?: string): Promise<void> {
    await this.update(id, {
      status: 'cancelled',
      metadata: {
        ...(await this.findById(id))?.metadata,
        cancellation_reason: reason,
        cancelled_at: new Date(),
      },
    });
  }

  /**
   * Get digests by business
   */
  async getByBusiness(
    businessId: string,
    options?: {
      type?: NotificationType;
      status?: NotificationDigest['status'];
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ digests: NotificationDigest[]; total: number }> {
    let sql = 'SELECT * FROM notification_digests WHERE business_id = $1 AND deleted_at IS NULL';
    const countSql = 'SELECT COUNT(*) FROM notification_digests WHERE business_id = $1 AND deleted_at IS NULL';
    const conditions: string[] = [];
    const params: any[] = [businessId];
    let paramIndex = 2;

    if (options?.type) {
      conditions.push(`type = $${paramIndex}`);
      params.push(options.type);
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

    sql += ` ORDER BY 
               CASE priority
                 WHEN 'critical' THEN 1
                 WHEN 'high' THEN 2
                 WHEN 'medium' THEN 3
                 WHEN 'low' THEN 4
               END,
               created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    
    const limit = options?.limit || 20;
    const offset = options?.offset || 0;
    params.push(limit, offset);

    const [digests, countResult] = await Promise.all([
      db.query(sql, params),
      db.query(countSql, [businessId]),
    ]);

    return {
      digests: digests.rows,
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * Get digests by user
   */
  async getByUser(
    userId: string,
    options?: {
      status?: NotificationDigest['status'];
      limit?: number;
      offset?: number;
    }
  ): Promise<NotificationDigest[]> {
    return this.find({
      user_id: userId,
      ...(options?.status ? { status: options.status } : {}),
    }, {
      limit: options?.limit,
      offset: options?.offset,
      orderBy: 'created_at',
      orderDir: 'DESC',
    });
  }

  /**
   * Get digest statistics
   */
  async getStatistics(
    businessId: string,
    fromDate?: Date,
    toDate?: Date
  ): Promise<any> {
    const dateFilter = fromDate && toDate ? 'AND created_at BETWEEN $2 AND $3' : '';
    const params: any[] = [businessId];
    
    if (fromDate && toDate) {
      params.push(fromDate, toDate);
    }

    const query = `
      SELECT
        type,
        priority,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        COUNT(DISTINCT user_id) as unique_recipients,
        SUM(jsonb_array_length(items)) as total_items
      FROM notification_digests
      WHERE business_id = $1
        AND deleted_at IS NULL
        ${dateFilter}
      GROUP BY type, priority
    `;

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Aggregate notifications into digest
   */
  async aggregateForBusiness(
    businessId: string,
    frequency: 'daily' | 'weekly' | 'monthly'
  ): Promise<NotificationDigest | null> {
    // Determine time range
    const now = new Date();
    let startDate: Date;

    switch (frequency) {
      case 'daily':
        startDate = new Date(now.setDate(now.getDate() - 1));
        break;
      case 'weekly':
        startDate = new Date(now.setDate(now.getDate() - 7));
        break;
      case 'monthly':
        startDate = new Date(now.setMonth(now.getMonth() - 1));
        break;
    }

    // Get pending notifications
    const pendingDigests = await this.find({
      business_id: businessId,
      status: 'pending',
      created_at: { $gte: startDate } as any,
    });

    if (pendingDigests.length === 0) {
      return null;
    }

    // Group by type
    const grouped: Record<string, NotificationDigest['items']> = {};
    
    for (const digest of pendingDigests) {
      if (!grouped[digest.type]) {
        grouped[digest.type] = [];
      }
      grouped[digest.type].push(...digest.items);
    }

    // Create summary digest
    const summary: NotificationDigest['items'] = [];
    const itemCount = pendingDigests.reduce((acc, d) => acc + d.items.length, 0);

    if (itemCount > 0) {
      summary.push({
        id: `summary-${Date.now()}`,
        type: 'summary',
        title: `${frequency.charAt(0).toUpperCase() + frequency.slice(1)} Digest`,
        description: `You have ${itemCount} notifications from the past ${frequency}`,
        metadata: {
          by_type: Object.keys(grouped).map(type => ({
            type,
            count: grouped[type].length,
          })),
        },
        created_at: new Date(),
      });
    }

    // Create the digest
    const digest = await this.createDigest({
      business_id: businessId,
      type: 'success', // Default type
      title: `${frequency.charAt(0).toUpperCase() + frequency.slice(1)} Notification Digest`,
      summary: `Summary of ${itemCount} notifications`,
      items: summary,
      priority: 'medium',
      channels: ['email'],
      metadata: {
        frequency,
        period_start: startDate,
        period_end: new Date(),
        original_digests: pendingDigests.map(d => d.id),
        grouped_notifications: grouped,
      },
    });

    // Mark original digests as processed
    for (const d of pendingDigests) {
      await this.cancel(d.id, 'Aggregated into digest');
    }

    return digest;
  }

  /**
   * Clean up expired digests
   */
  async cleanupExpired(): Promise<number> {
    const query = `
      UPDATE notification_digests
      SET status = 'cancelled',
          metadata = metadata || jsonb_build_object('cleanup_reason', 'expired')
      WHERE expires_at < NOW()
        AND status = 'pending'
      RETURNING id
    `;

    const result = await db.query(query);
    return result.rowCount || 0;
  }
}

export const notificationDigestModel = new NotificationDigestModel();

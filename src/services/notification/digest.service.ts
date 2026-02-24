// src/services/notification/digest.service.ts
import { Queue } from 'bullmq';
import { db } from '../../config/database';
import { redisConnection } from '../../config/redis';
import { logger } from '../../config/logger';
import { emailChannel } from './channels/email.channel';
import { smsChannel } from './channels/sms.channel';
import { pushChannel } from './channels/push.channel';

export interface DigestConfig {
  businessId: string;
  frequency: 'daily' | 'weekly' | 'monthly' | 'immediate';
  channels: ('email' | 'sms' | 'push')[];
  types: ('success' | 'action_required' | 'integration' | 'regulatory')[];
}

export interface DigestContent {
  id: string;
  businessId: string;
  type: 'success' | 'action_required' | 'integration' | 'regulatory';
  title: string;
  summary: string;
  items: DigestItem[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  metadata: Record<string, any>;
  createdAt: Date;
}

export interface DigestItem {
  id: string;
  type: string;
  title: string;
  description: string;
  actionUrl?: string;
  actionLabel?: string;
  metadata: Record<string, any>;
}

export class DigestService {
  private static digestQueue = new Queue('digest-processing', { connection: redisConnection });
  private static immediateQueue = new Queue('immediate-notifications', { connection: redisConnection });

  /**
   * Create a new digest
   */
  static async createDigest(
    businessId: string,
    type: DigestContent['type'],
    data: Partial<DigestContent>
  ): Promise<DigestContent> {
    const digest: DigestContent = {
      id: crypto.randomUUID(),
      businessId,
      type,
      title: data.title || this.getDefaultTitle(type),
      summary: data.summary || '',
      items: data.items || [],
      priority: data.priority || this.getDefaultPriority(type),
      metadata: data.metadata || {},
      createdAt: new Date()
    };

    // Store digest in database
    const result = await db.query(
      `INSERT INTO notification_digests (
        id, business_id, type, title, summary, items, 
        priority, metadata, created_at, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
      RETURNING *`,
      [
        digest.id,
        digest.businessId,
        digest.type,
        digest.title,
        digest.summary,
        JSON.stringify(digest.items),
        digest.priority,
        JSON.stringify(digest.metadata),
        digest.createdAt
      ]
    );

    // Determine if immediate or queued
    if (type === 'action_required' || digest.priority === 'critical') {
      await this.sendImmediate(digest);
    } else {
      await this.queueForDigest(digest);
    }

    return digest;
  }

  /**
   * Add item to existing digest
   */
  static async addToDigest(
    digestId: string,
    item: DigestItem
  ): Promise<void> {
    await db.query(
      `UPDATE notification_digests
       SET items = items || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify([item]), digestId]
    );
  }

  /**
   * Send immediate notification (for critical/alerts)
   */
  private static async sendImmediate(digest: DigestContent): Promise<void> {
    // Get business notification preferences
    const prefs = await this.getBusinessPreferences(digest.businessId);

    // Send through all enabled channels
    const promises = prefs.channels.map(channel => {
      switch (channel) {
        case 'email':
          return this.sendEmailAlert(digest, prefs);
        case 'sms':
          return this.sendSMSAlert(digest, prefs);
        case 'push':
          return this.sendPushAlert(digest, prefs);
        default:
          return Promise.resolve();
      }
    });

    await Promise.all(promises);

    // Mark as sent
    await db.query(
      `UPDATE notification_digests 
       SET status = 'sent', sent_at = NOW()
       WHERE id = $1`,
      [digest.id]
    );
  }

  /**
   * Queue for scheduled digest
   */
  private static async queueForDigest(digest: DigestContent): Promise<void> {
    const prefs = await this.getBusinessPreferences(digest.businessId);
    
    await this.digestQueue.add('add-to-digest', {
      digest,
      prefs
    }, {
      jobId: `${digest.businessId}-${digest.type}-${new Date().toDateString()}`,
      removeOnComplete: true
    });
  }

  /**
   * Process and send scheduled digests
   */
  static async processScheduledDigests(frequency: 'daily' | 'weekly' | 'monthly'): Promise<void> {
    const businesses = await this.getBusinessesForDigest(frequency);

    for (const business of businesses) {
      try {
        // Aggregate all pending notifications
        const pendingDigests = await db.query(
          `SELECT * FROM notification_digests
           WHERE business_id = $1
             AND status = 'pending'
             AND created_at >= NOW() - INTERVAL '1 day'
           ORDER BY priority DESC, created_at ASC`,
          [business.id]
        );

        if (pendingDigests.rows.length === 0) {
          continue;
        }

        // Group by type
        const grouped = this.groupDigests(pendingDigests.rows);

        // Create digest email
        await this.sendDigestEmail(business, grouped, frequency);

        // Mark all as sent
        await db.query(
          `UPDATE notification_digests
           SET status = 'sent', sent_at = NOW()
           WHERE id = ANY($1::uuid[])`,
          [pendingDigests.rows.map(d => d.id)]
        );

        logger.info(`Digest sent for business ${business.id}`, {
          frequency,
          count: pendingDigests.rows.length
        });

      } catch (error) {
        logger.error(`Failed to send digest for business ${business.id}:`, error);
      }
    }
  }

  /**
   * Send email alert for immediate notifications
   */
  private static async sendEmailAlert(digest: DigestContent, prefs: any): Promise<void> {
    const template = digest.type === 'action_required' 
      ? 'action-required'
      : 'integration-disconnected';

    await emailChannel.send({
      to: prefs.email,
      subject: digest.title,
      template,
      data: {
        digest,
        businessName: prefs.businessName,
        items: digest.items,
        actionUrl: digest.items[0]?.actionUrl
      }
    });
  }

  /**
   * Send SMS alert for critical notifications
   */
  private static async sendSMSAlert(digest: DigestContent, prefs: any): Promise<void> {
    if (digest.priority === 'critical' && prefs.phone) {
      const message = `${digest.title}: ${digest.items.length} items require attention`;
      
      await smsChannel.send({
        to: prefs.phone,
        message
      });
    }
  }

  /**
   * Send push notification
   */
  private static async sendPushAlert(digest: DigestContent, prefs: any): Promise<void> {
    await pushChannel.send({
      userId: prefs.userId,
      title: digest.title,
      body: digest.summary || `${digest.items.length} new notifications`,
      data: {
        digestId: digest.id,
        type: digest.type,
        actionUrl: digest.items[0]?.actionUrl
      }
    });
  }

  /**
   * Send comprehensive digest email
   */
  private static async sendDigestEmail(
    business: any,
    grouped: Record<string, any>,
    frequency: string
  ): Promise<void> {
    await emailChannel.send({
      to: business.email,
      subject: `Your ${frequency} Elexsol Digest`,
      template: 'daily-digest',
      data: {
        businessName: business.name,
        frequency,
        date: new Date().toLocaleDateString(),
        summary: {
          total: Object.values(grouped).reduce((acc: number, g: any) => acc + g.count, 0),
          actionRequired: grouped.action_required?.count || 0,
          successes: grouped.success?.count || 0,
          integrations: grouped.integration?.count || 0,
          regulatory: grouped.regulatory?.count || 0
        },
        groups: grouped
      }
    });
  }

  private static getDefaultTitle(type: string): string {
    const titles = {
      success: '✅ Action Completed Successfully',
      action_required: '⚠️ Action Required',
      integration: '🔄 Integration Update',
      regulatory: '📋 Regulatory Notification'
    };
    return titles[type] || 'Notification';
  }

  private static getDefaultPriority(type: string): 'low' | 'medium' | 'high' | 'critical' {
    const priorities = {
      success: 'low',
      action_required: 'high',
      integration: 'medium',
      regulatory: 'medium'
    };
    return priorities[type] || 'medium';
  }

  private static async getBusinessPreferences(businessId: string): Promise<any> {
    const result = await db.query(
      `SELECT b.*, u.email, u.phone, u.id as user_id
       FROM businesses b
       JOIN users u ON u.business_id = b.id
       WHERE b.id = $1 AND u.primary_contact = true`,
      [businessId]
    );
    return result.rows[0];
  }

  private static async getBusinessesForDigest(frequency: string): Promise<any[]> {
    const result = await db.query(
      `SELECT DISTINCT b.*, u.email, u.phone, u.id as user_id
       FROM businesses b
       JOIN users u ON u.business_id = b.id
       WHERE u.notification_frequency = $1
         AND u.notifications_enabled = true
         AND u.primary_contact = true`,
      [frequency]
    );
    return result.rows;
  }

  private static groupDigests(digests: any[]): Record<string, any> {
    const grouped: Record<string, any> = {};

    digests.forEach(digest => {
      if (!grouped[digest.type]) {
        grouped[digest.type] = {
          type: digest.type,
          count: 0,
          items: [],
          priority: digest.priority
        };
      }

      grouped[digest.type].count++;
      grouped[digest.type].items.push(...digest.items);
    });

    return grouped;
  }
}

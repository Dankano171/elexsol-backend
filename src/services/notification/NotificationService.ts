import { notificationDigestModel } from '../../models/NotificationDigest';
import { userRepository } from '../../repositories/UserRepository';
import { businessRepository } from '../../repositories/BusinessRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { emailChannel } from './channels/EmailChannel';
import { smsChannel } from './channels/SMSChannel';
import { pushChannel } from './channels/PushChannel';
import { inAppChannel } from './channels/InAppChannel';
import { whatsappChannel } from './channels/WhatsAppChannel';
import { 
  NotificationType, 
  NotificationPriority,
  NotificationChannel,
  NOTIFICATION_TYPES,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_CHANNELS
} from '../../config/constants/business-rules';

export interface Notification {
  id: string;
  businessId: string;
  userId?: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, any>;
  priority: NotificationPriority;
  channels: NotificationChannel[];
  status: 'pending' | 'sent' | 'failed' | 'read' | 'dismissed';
  scheduledFor?: Date;
  expiresAt?: Date;
  readAt?: Date;
  dismissedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationPreferences {
  email: boolean;
  sms: boolean;
  push: boolean;
  inApp: boolean;
  whatsapp: boolean;
  digest: 'immediate' | 'daily' | 'weekly' | 'never';
  types: Record<NotificationType, boolean>;
  quietHours?: {
    enabled: boolean;
    start: string; // HH:mm format
    end: string; // HH:mm format
    timezone: string;
  };
}

export class NotificationService {
  private readonly channels = {
    email: emailChannel,
    sms: smsChannel,
    push: pushChannel,
    inApp: inAppChannel,
    whatsapp: whatsappChannel
  };

  /**
   * Send notification
   */
  async send(notification: Partial<Notification>): Promise<Notification> {
    try {
      // Get user preferences
      const preferences = notification.userId 
        ? await this.getUserPreferences(notification.userId)
        : await this.getBusinessPreferences(notification.businessId!);

      // Filter channels based on preferences and quiet hours
      const allowedChannels = await this.filterChannelsByPreferences(
        notification.channels || [],
        preferences,
        notification.type!,
        notification.userId
      );

      if (allowedChannels.length === 0) {
        logger.debug('No channels available for notification', { notification });
        return null!;
      }

      // Create notification record
      const created = await notificationDigestModel.createDigest({
        business_id: notification.businessId!,
        user_id: notification.userId,
        type: notification.type!,
        title: notification.title!,
        summary: notification.body,
        items: notification.data ? [{
          id: `item-${Date.now()}`,
          type: 'notification',
          title: notification.title!,
          description: notification.body,
          metadata: notification.data,
          created_at: new Date()
        }] : [],
        priority: notification.priority || 'medium',
        channels: allowedChannels,
        scheduled_for: notification.scheduledFor,
        expires_at: notification.expiresAt
      });

      // Send through each channel
      const results = await Promise.allSettled(
        allowedChannels.map(channel => 
          this.sendViaChannel(channel, created, preferences)
        )
      );

      // Check for failures
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        logger.error('Some notification channels failed', { failures });
      }

      return this.mapToNotification(created);
    } catch (error) {
      logger.error('Error sending notification:', error);
      throw error;
    }
  }

  /**
   * Send notification via specific channel
   */
  private async sendViaChannel(
    channel: NotificationChannel,
    notification: any,
    preferences: NotificationPreferences
  ): Promise<void> {
    const channelImpl = this.channels[channel];
    
    if (!channelImpl) {
      throw new Error(`Channel ${channel} not implemented`);
    }

    await channelImpl.send({
      userId: notification.user_id,
      businessId: notification.business_id,
      title: notification.title,
      body: notification.summary || notification.items[0]?.description,
      data: notification.items[0]?.metadata,
      preferences
    });
  }

  /**
   * Send bulk notifications
   */
  async sendBulk(notifications: Partial<Notification>[]): Promise<Notification[]> {
    const results = await Promise.allSettled(
      notifications.map(n => this.send(n))
    );

    return results
      .filter((r): r is PromiseFulfilledResult<Notification> => r.status === 'fulfilled')
      .map(r => r.value);
  }

  /**
   * Schedule notification for later
   */
  async schedule(
    notification: Partial<Notification>,
    sendAt: Date
  ): Promise<Notification> {
    return this.send({
      ...notification,
      scheduledFor: sendAt
    });
  }

  /**
   * Cancel scheduled notification
   */
  async cancel(notificationId: string): Promise<boolean> {
    await notificationDigestModel.update(notificationId, {
      status: 'cancelled'
    });
    return true;
  }

  /**
   * Mark notification as read
   */
  async markAsRead(notificationId: string, userId: string): Promise<void> {
    await notificationDigestModel.update(notificationId, {
      status: 'read',
      read_at: new Date()
    });
  }

  /**
   * Mark notification as dismissed
   */
  async dismiss(notificationId: string, userId: string): Promise<void> {
    await notificationDigestModel.update(notificationId, {
      status: 'dismissed',
      dismissed_at: new Date()
    });
  }

  /**
   * Get user notifications
   */
  async getUserNotifications(
    userId: string,
    options?: {
      type?: NotificationType;
      status?: string;
      limit?: number;
      offset?: number;
      unreadOnly?: boolean;
    }
  ): Promise<{ notifications: Notification[]; total: number; unreadCount: number }> {
    const user = await userRepository.findById(userId);
    
    if (!user) {
      throw new Error('User not found');
    }

    const result = await notificationDigestModel.getByBusiness(
      user.business_id,
      {
        type: options?.type,
        status: options?.status,
        limit: options?.limit,
        offset: options?.offset
      }
    );

    const unreadCount = await notificationDigestModel.count({
      user_id: userId,
      status: 'sent'
    });

    return {
      notifications: result.digests.map(d => this.mapToNotification(d)),
      total: result.total,
      unreadCount
    };
  }

  /**
   * Get unread count
   */
  async getUnreadCount(userId: string): Promise<number> {
    return notificationDigestModel.count({
      user_id: userId,
      status: 'sent'
    });
  }

  /**
   * Mark all as read
   */
  async markAllAsRead(userId: string): Promise<number> {
    const user = await userRepository.findById(userId);
    
    if (!user) {
      throw new Error('User not found');
    }

    const result = await notificationDigestModel.bulkUpdate(
      [],
      { status: 'read', read_at: new Date() }
    );

    return result;
  }

  /**
   * Get user notification preferences
   */
  async getUserPreferences(userId: string): Promise<NotificationPreferences> {
    const user = await userRepository.findById(userId);
    
    if (!user) {
      throw new Error('User not found');
    }

    return {
      email: user.notification_preferences?.email ?? true,
      sms: user.notification_preferences?.sms ?? false,
      push: user.notification_preferences?.push ?? true,
      inApp: true,
      whatsapp: false,
      digest: user.notification_preferences?.digest || 'daily',
      types: {
        success: true,
        action_required: true,
        integration: true,
        regulatory: true
      },
      quietHours: user.notification_preferences?.quietHours
    };
  }

  /**
   * Get business notification preferences
   */
  async getBusinessPreferences(businessId: string): Promise<NotificationPreferences> {
    const business = await businessRepository.findById(businessId);
    
    if (!business) {
      throw new Error('Business not found');
    }

    return {
      email: true,
      sms: business.settings?.notifications?.sms ?? false,
      push: false,
      inApp: true,
      whatsapp: false,
      digest: business.settings?.notifications?.digest || 'daily',
      types: {
        success: true,
        action_required: true,
        integration: true,
        regulatory: true
      }
    };
  }

  /**
   * Update user preferences
   */
  async updateUserPreferences(
    userId: string,
    preferences: Partial<NotificationPreferences>
  ): Promise<NotificationPreferences> {
    const user = await userRepository.findById(userId);
    
    if (!user) {
      throw new Error('User not found');
    }

    const updated = await userRepository.updateNotificationPreferences(
      userId,
      {
        ...user.notification_preferences,
        ...preferences
      }
    );

    return this.mapToPreferences(updated);
  }

  /**
   * Filter channels based on preferences and quiet hours
   */
  private async filterChannelsByPreferences(
    channels: NotificationChannel[],
    preferences: NotificationPreferences,
    type: NotificationType,
    userId?: string
  ): Promise<NotificationChannel[]> {
    // Filter by type preference
    if (!preferences.types[type]) {
      return [];
    }

    // Filter by channel availability
    const available = channels.filter(channel => {
      switch (channel) {
        case 'email': return preferences.email;
        case 'sms': return preferences.sms;
        case 'push': return preferences.push;
        case 'inapp': return preferences.inApp;
        case 'whatsapp': return preferences.whatsapp;
        default: return false;
      }
    });

    // Apply quiet hours if enabled
    if (preferences.quietHours?.enabled && userId) {
      const now = new Date();
      const currentTime = format(now, 'HH:mm');
      const { start, end, timezone } = preferences.quietHours;

      // Convert to user's timezone if needed
      // This is simplified - in production use proper timezone handling

      if (this.isInQuietHours(currentTime, start, end)) {
        // Only allow high priority during quiet hours
        return available.filter(c => c === 'inapp'); // Only in-app during quiet hours
      }
    }

    return available;
  }

  /**
   * Check if current time is within quiet hours
   */
  private isInQuietHours(current: string, start: string, end: string): boolean {
    const now = current.replace(':', '');
    const startTime = start.replace(':', '');
    const endTime = end.replace(':', '');

    if (startTime < endTime) {
      return now >= startTime && now <= endTime;
    } else {
      // Overnight quiet hours
      return now >= startTime || now <= endTime;
    }
  }

  /**
   * Map database model to notification object
   */
  private mapToNotification(model: any): Notification {
    return {
      id: model.id,
      businessId: model.business_id,
      userId: model.user_id,
      type: model.type,
      title: model.title,
      body: model.summary || model.items[0]?.description,
      data: model.items[0]?.metadata,
      priority: model.priority,
      channels: model.channels,
      status: model.status,
      scheduledFor: model.scheduled_for,
      expiresAt: model.expires_at,
      readAt: model.read_at,
      dismissedAt: model.dismissed_at,
      createdAt: model.created_at,
      updatedAt: model.updated_at
    };
  }

  /**
   * Map to preferences
   */
  private mapToPreferences(user: any): NotificationPreferences {
    return {
      email: user.notification_preferences?.email ?? true,
      sms: user.notification_preferences?.sms ?? false,
      push: user.notification_preferences?.push ?? true,
      inApp: true,
      whatsapp: false,
      digest: user.notification_preferences?.digest || 'daily',
      types: {
        success: true,
        action_required: true,
        integration: true,
        regulatory: true
      },
      quietHours: user.notification_preferences?.quietHours
    };
  }
}

export const notificationService = new NotificationService();

// Helper function for time formatting
function format(date: Date, format: string): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

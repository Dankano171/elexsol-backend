import { notificationDigestModel } from '../../../models/NotificationDigest';
import { redis } from '../../../config/redis';
import { logger } from '../../../config/logger';
import { Server as SocketServer } from 'socket.io';

export interface InAppNotification {
  id: string;
  userId: string;
  businessId: string;
  title: string;
  body: string;
  type: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  data?: Record<string, any>;
  read: boolean;
  readAt?: Date;
  createdAt: Date;
  expiresAt?: Date;
}

export interface InAppOptions {
  userId: string;
  businessId: string;
  title: string;
  body: string;
  type?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  data?: Record<string, any>;
  expiresIn?: number; // seconds
}

export class InAppChannel {
  private io: SocketServer | null = null;
  private readonly userRoomsPrefix = 'user:';
  private readonly unreadKeyPrefix = 'unread:';

  /**
   * Initialize Socket.IO
   */
  initialize(io: SocketServer): void {
    this.io = io;
    
    // Setup connection handling
    io.on('connection', (socket) => {
      const userId = socket.handshake.auth.userId;
      
      if (userId) {
        // Join user's room
        socket.join(this.getUserRoom(userId));
        
        // Send unread count
        this.sendUnreadCount(userId);
        
        socket.on('disconnect', () => {
          socket.leave(this.getUserRoom(userId));
        });
        
        socket.on('mark-read', (notificationId: string) => {
          this.markAsRead(userId, notificationId);
        });
        
        socket.on('mark-all-read', () => {
          this.markAllAsRead(userId);
        });
      }
    });
  }

  /**
   * Send in-app notification
   */
  async send(options: InAppOptions): Promise<InAppNotification> {
    try {
      // Create notification
      const notification = await notificationDigestModel.createDigest({
        business_id: options.businessId,
        user_id: options.userId,
        type: (options.type as any) || 'info',
        title: options.title,
        summary: options.body,
        items: [{
          id: `item-${Date.now()}`,
          type: options.type || 'notification',
          title: options.title,
          description: options.body,
          metadata: options.data || {},
          created_at: new Date()
        }],
        priority: options.priority || 'medium',
        channels: ['inapp'],
        expires_at: options.expiresIn ? new Date(Date.now() + options.expiresIn * 1000) : undefined
      });

      const inAppNotification: InAppNotification = {
        id: notification.id,
        userId: options.userId,
        businessId: options.businessId,
        title: options.title,
        body: options.body,
        type: options.type || 'info',
        priority: options.priority || 'medium',
        data: options.data,
        read: false,
        createdAt: notification.created_at,
        expiresAt: notification.expires_at
      };

      // Store in Redis for quick access
      await this.storeNotification(inAppNotification);

      // Increment unread count
      await this.incrementUnreadCount(options.userId);

      // Send real-time if socket.io is available
      if (this.io) {
        this.io.to(this.getUserRoom(options.userId)).emit('notification', inAppNotification);
      }

      return inAppNotification;
    } catch (error) {
      logger.error('Error sending in-app notification:', error);
      throw error;
    }
  }

  /**
   * Send notification (for notification service)
   */
  async sendNotification(data: {
    userId?: string;
    businessId: string;
    title: string;
    body: string;
    data?: Record<string, any>;
    preferences: any;
  }): Promise<void> {
    if (!data.userId) {
      return;
    }

    await this.send({
      userId: data.userId,
      businessId: data.businessId,
      title: data.title,
      body: data.body,
      data: data.data
    });
  }

  /**
   * Get user's notifications
   */
  async getUserNotifications(
    userId: string,
    options?: {
      limit?: number;
      offset?: number;
      unreadOnly?: boolean;
    }
  ): Promise<{
    notifications: InAppNotification[];
    total: number;
    unreadCount: number;
  }> {
    const pattern = `inapp:${userId}:*`;
    const keys = await redis.keys(pattern);
    
    // Sort by timestamp (newest first)
    const notifications: InAppNotification[] = [];
    
    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const notif = JSON.parse(data);
        if (!options?.unreadOnly || !notif.read) {
          notifications.push(notif);
        }
      }
    }

    // Sort by createdAt desc
    notifications.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const unreadCount = await this.getUnreadCount(userId);

    return {
      notifications: notifications.slice(options?.offset || 0, (options?.offset || 0) + (options?.limit || 50)),
      total: notifications.length,
      unreadCount
    };
  }

  /**
   * Mark notification as read
   */
  async markAsRead(userId: string, notificationId: string): Promise<void> {
    const key = `inapp:${userId}:${notificationId}`;
    const data = await redis.get(key);
    
    if (data) {
      const notification = JSON.parse(data);
      if (!notification.read) {
        notification.read = true;
        notification.readAt = new Date();
        await redis.setex(key, 7 * 24 * 60 * 60, JSON.stringify(notification));
        
        // Decrement unread count
        await this.decrementUnreadCount(userId);
        
        // Emit update
        if (this.io) {
          this.io.to(this.getUserRoom(userId)).emit('notification-read', notificationId);
        }
      }
    }
  }

  /**
   * Mark all as read
   */
  async markAllAsRead(userId: string): Promise<void> {
    const pattern = `inapp:${userId}:*`;
    const keys = await redis.keys(pattern);
    
    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const notification = JSON.parse(data);
        if (!notification.read) {
          notification.read = true;
          notification.readAt = new Date();
          await redis.setex(key, 7 * 24 * 60 * 60, JSON.stringify(notification));
        }
      }
    }

    // Reset unread count
    await redis.set(`${this.unreadKeyPrefix}${userId}`, '0');

    // Emit update
    if (this.io) {
      this.io.to(this.getUserRoom(userId)).emit('all-notifications-read');
    }
  }

  /**
   * Delete notification
   */
  async delete(userId: string, notificationId: string): Promise<void> {
    const key = `inapp:${userId}:${notificationId}`;
    const data = await redis.get(key);
    
    if (data) {
      const notification = JSON.parse(data);
      if (!notification.read) {
        await this.decrementUnreadCount(userId);
      }
      
      await redis.del(key);
      
      if (this.io) {
        this.io.to(this.getUserRoom(userId)).emit('notification-deleted', notificationId);
      }
    }
  }

  /**
   * Store notification in Redis
   */
  private async storeNotification(notification: InAppNotification): Promise<void> {
    const key = `inapp:${notification.userId}:${notification.id}`;
    const ttl = notification.expiresAt 
      ? Math.ceil((notification.expiresAt.getTime() - Date.now()) / 1000)
      : 7 * 24 * 60 * 60; // 7 days default

    await redis.setex(key, ttl, JSON.stringify(notification));
  }

  /**
   * Increment unread count
   */
  private async incrementUnreadCount(userId: string): Promise<void> {
    const key = `${this.unreadKeyPrefix}${userId}`;
    await redis.incr(key);
    
    // Send updated count
    await this.sendUnreadCount(userId);
  }

  /**
   * Decrement unread count
   */
  private async decrementUnreadCount(userId: string): Promise<void> {
    const key = `${this.unreadKeyPrefix}${userId}`;
    const current = await redis.get(key);
    
    if (current && parseInt(current) > 0) {
      await redis.decr(key);
    }
    
    // Send updated count
    await this.sendUnreadCount(userId);
  }

  /**
   * Get unread count
   */
  async getUnreadCount(userId: string): Promise<number> {
    const key = `${this.unreadKeyPrefix}${userId}`;
    const count = await redis.get(key);
    return count ? parseInt(count) : 0;
  }

  /**
   * Send unread count via socket
   */
  private async sendUnreadCount(userId: string): Promise<void> {
    if (!this.io) return;
    
    const count = await this.getUnreadCount(userId);
    this.io.to(this.getUserRoom(userId)).emit('unread-count', count);
  }

  /**
   * Get user's socket room
   */
  private getUserRoom(userId: string): string {
    return `${this.userRoomsPrefix}${userId}`;
  }
}

export const inAppChannel = new InAppChannel();

import { Request, Response } from 'express';
import { notificationService } from '../../services/notification/NotificationService';
import { inAppChannel } from '../../services/notification/channels/InAppChannel';
import { logger } from '../../config/logger';
import { permissionService } from '../../services/auth/PermissionService';

export class NotificationController {
  /**
   * Get user notifications
   */
  async getUserNotifications(req: Request, res: Response): Promise<void> {
    try {
      const {
        page = 1,
        limit = 20,
        type,
        unreadOnly = false
      } = req.query;

      const result = await notificationService.getUserNotifications(
        req.user.id,
        {
          type: type as any,
          unreadOnly: unreadOnly === 'true',
          limit: Number(limit),
          offset: (Number(page) - 1) * Number(limit)
        }
      );

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Get user notifications error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get unread count
   */
  async getUnreadCount(req: Request, res: Response): Promise<void> {
    try {
      const count = await notificationService.getUnreadCount(req.user.id);

      res.json({
        success: true,
        data: { count }
      });
    } catch (error) {
      logger.error('Get unread count error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Mark notification as read
   */
  async markAsRead(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      await notificationService.markAsRead(id, req.user.id);

      res.json({
        success: true,
        message: 'Notification marked as read'
      });
    } catch (error) {
      logger.error('Mark as read error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Mark all as read
   */
  async markAllAsRead(req: Request, res: Response): Promise<void> {
    try {
      const count = await notificationService.markAllAsRead(req.user.id);

      res.json({
        success: true,
        data: { marked: count }
      });
    } catch (error) {
      logger.error('Mark all as read error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Dismiss notification
   */
  async dismissNotification(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      await notificationService.dismiss(id, req.user.id);

      res.json({
        success: true,
        message: 'Notification dismissed'
      });
    } catch (error) {
      logger.error('Dismiss notification error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get notification preferences
   */
  async getPreferences(req: Request, res: Response): Promise<void> {
    try {
      const preferences = await notificationService.getUserPreferences(req.user.id);

      res.json({
        success: true,
        data: preferences
      });
    } catch (error) {
      logger.error('Get preferences error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update notification preferences
   */
  async updatePreferences(req: Request, res: Response): Promise<void> {
    try {
      const preferences = req.body;

      const updated = await notificationService.updateUserPreferences(
        req.user.id,
        preferences
      );

      res.json({
        success: true,
        data: updated
      });
    } catch (error) {
      logger.error('Update preferences error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Send test notification
   */
  async sendTestNotification(req: Request, res: Response): Promise<void> {
    try {
      const { channel } = req.params;

      await notificationService.send({
        businessId: req.user.business_id,
        userId: req.user.id,
        type: 'success',
        title: 'Test Notification',
        body: 'This is a test notification from Elexsol',
        channels: [channel as any],
        priority: 'low'
      });

      res.json({
        success: true,
        message: 'Test notification sent'
      });
    } catch (error) {
      logger.error('Send test notification error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Subscribe to push notifications
   */
  async subscribePush(req: Request, res: Response): Promise<void> {
    try {
      const { token, platform, deviceId, model, appVersion } = req.body;

      await pushChannel.registerToken({
        userId: req.user.id,
        token,
        platform,
        deviceId,
        model,
        appVersion,
        lastUsed: new Date(),
        active: true
      });

      res.json({
        success: true,
        message: 'Push subscription successful'
      });
    } catch (error) {
      logger.error('Subscribe push error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Unsubscribe from push notifications
   */
  async unsubscribePush(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.body;

      await pushChannel.removeToken(token);

      res.json({
        success: true,
        message: 'Push unsubscription successful'
      });
    } catch (error) {
      logger.error('Unsubscribe push error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get in-app notifications
   */
  async getInAppNotifications(req: Request, res: Response): Promise<void> {
    try {
      const { limit = 50, unreadOnly = false } = req.query;

      const notifications = await inAppChannel.getUserNotifications(
        req.user.id,
        {
          limit: Number(limit),
          unreadOnly: unreadOnly === 'true'
        }
      );

      res.json({
        success: true,
        data: notifications
      });
    } catch (error) {
      logger.error('Get in-app notifications error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Schedule notification
   */
  async scheduleNotification(req: Request, res: Response): Promise<void> {
    try {
      const { sendAt, ...notification } = req.body;

      const scheduled = await notificationService.schedule(
        {
          ...notification,
          businessId: req.user.business_id,
          userId: req.user.id
        },
        new Date(sendAt)
      );

      res.status(201).json({
        success: true,
        data: scheduled
      });
    } catch (error) {
      logger.error('Schedule notification error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Cancel scheduled notification
   */
  async cancelScheduled(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const cancelled = await notificationService.cancel(id);

      if (!cancelled) {
        res.status(404).json({
          success: false,
          error: 'Scheduled notification not found'
        });
        return;
      }

      res.json({
        success: true,
        message: 'Scheduled notification cancelled'
      });
    } catch (error) {
      logger.error('Cancel scheduled error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get notification statistics
   */
  async getStatistics(req: Request, res: Response): Promise<void> {
    try {
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'admin:read'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      // This would aggregate notification stats
      // Placeholder response
      res.json({
        success: true,
        data: {
          total: 1500,
          sent: 1450,
          failed: 50,
          byChannel: {
            email: 800,
            sms: 300,
            push: 250,
            inapp: 100
          }
        }
      });
    } catch (error) {
      logger.error('Get statistics error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const notificationController = new NotificationController();

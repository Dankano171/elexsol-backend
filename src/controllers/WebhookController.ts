import { Request, Response } from 'express';
import { webhookService } from '../../services/webhook/WebhookService';
import { webhookSecurity } from '../../services/webhook/WebhookSecurity';
import { webhookQueue } from '../../services/queue/WebhookQueue';
import { logger } from '../../config/logger';
import { permissionService } from '../../services/auth/PermissionService';

export class WebhookController {
  /**
   * Register webhook
   */
  async registerWebhook(req: Request, res: Response): Promise<void> {
    try {
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'integration:update'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const { integrationId, url, events, metadata } = req.body;

      const registration = await webhookService.registerWebhook(
        req.user.business_id,
        integrationId,
        url,
        events,
        metadata
      );

      res.status(201).json({
        success: true,
        data: registration
      });
    } catch (error) {
      logger.error('Register webhook error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Unregister webhook
   */
  async unregisterWebhook(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'integration:update'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      await webhookService.unregisterWebhook(id);

      res.json({
        success: true,
        message: 'Webhook unregistered successfully'
      });
    } catch (error) {
      logger.error('Unregister webhook error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get webhook status
   */
  async getWebhookStatus(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const status = await webhookService.getWebhookStatus(id);

      if (!status) {
        res.status(404).json({
          success: false,
          error: 'Webhook not found'
        });
        return;
      }

      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      logger.error('Get webhook status error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Pause webhook
   */
  async pauseWebhook(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'integration:update'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      await webhookService.pauseWebhook(id);

      res.json({
        success: true,
        message: 'Webhook paused'
      });
    } catch (error) {
      logger.error('Pause webhook error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Resume webhook
   */
  async resumeWebhook(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'integration:update'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      await webhookService.resumeWebhook(id);

      res.json({
        success: true,
        message: 'Webhook resumed'
      });
    } catch (error) {
      logger.error('Resume webhook error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update webhook events
   */
  async updateEvents(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { events } = req.body;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'integration:update'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      await webhookService.updateWebhookEvents(id, events);

      res.json({
        success: true,
        message: 'Webhook events updated'
      });
    } catch (error) {
      logger.error('Update events error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Retry failed webhook
   */
  async retryWebhook(req: Request, res: Response): Promise<void> {
    try {
      const { eventId } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'integration:update'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      await webhookService.retryWebhook(eventId);

      res.json({
        success: true,
        message: 'Webhook queued for retry'
      });
    } catch (error) {
      logger.error('Retry webhook error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get webhook queue status
   */
  async getQueueStatus(req: Request, res: Response): Promise<void> {
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

      const status = await webhookQueue.getStatus();

      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      logger.error('Get queue status error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get webhook security status
   */
  async getSecurityStatus(req: Request, res: Response): Promise<void> {
    try {
      const { provider } = req.params;

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

      const status = await webhookSecurity.getSecurityStatus(provider);

      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      logger.error('Get security status error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Add IP to whitelist (admin only)
   */
  async addToWhitelist(req: Request, res: Response): Promise<void> {
    try {
      const { provider, ip } = req.body;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'admin:write'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      await webhookSecurity.addToWhitelist(provider, ip);

      res.json({
        success: true,
        message: 'IP added to whitelist'
      });
    } catch (error) {
      logger.error('Add to whitelist error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Remove IP from whitelist (admin only)
   */
  async removeFromWhitelist(req: Request, res: Response): Promise<void> {
    try {
      const { provider, ip } = req.body;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'admin:write'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      await webhookSecurity.removeFromWhitelist(provider, ip);

      res.json({
        success: true,
        message: 'IP removed from whitelist'
      });
    } catch (error) {
      logger.error('Remove from whitelist error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Block IP (admin only)
   */
  async blockIP(req: Request, res: Response): Promise<void> {
    try {
      const { ip, reason, duration } = req.body;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'admin:write'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      await webhookSecurity.blockIP(ip, reason, duration);

      res.json({
        success: true,
        message: 'IP blocked'
      });
    } catch (error) {
      logger.error('Block IP error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Unblock IP (admin only)
   */
  async unblockIP(req: Request, res: Response): Promise<void> {
    try {
      const { ip } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'admin:write'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      await webhookSecurity.unblockIP(ip);

      res.json({
        success: true,
        message: 'IP unblocked'
      });
    } catch (error) {
      logger.error('Unblock IP error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Generate security report (admin only)
   */
  async generateSecurityReport(req: Request, res: Response): Promise<void> {
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

      const report = await webhookSecurity.generateSecurityReport();

      res.json({
        success: true,
        data: report
      });
    } catch (error) {
      logger.error('Generate security report error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Test webhook
   */
  async testWebhook(req: Request, res: Response): Promise<void> {
    try {
      const { url, payload } = req.body;

      // Trigger test webhook
      await webhookService.triggerWebhook(
        req.user.business_id,
        'test-integration',
        'test.event',
        payload
      );

      res.json({
        success: true,
        message: 'Test webhook triggered'
      });
    } catch (error) {
      logger.error('Test webhook error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const webhookController = new WebhookController();

import { Request, Response } from 'express';
import { integrationService } from '../../services/integrations/IntegrationService';
import { accountIntegrationRepository } from '../../repositories/AccountIntegrationRepository';
import { auditLogRepository } from '../../repositories/AuditLogRepository';
import { logger } from '../../config/logger';
import { permissionService } from '../../services/auth/PermissionService';
import { INTEGRATION_PROVIDERS } from '../../config/constants/business-rules';

export class IntegrationController {
  /**
   * Get all integrations
   */
  async getAllIntegrations(req: Request, res: Response): Promise<void> {
    try {
      const { provider } = req.query;

      const integrations = await integrationService.getBusinessIntegrations(
        req.user.business_id,
        provider as any
      );

      res.json({
        success: true,
        data: integrations
      });
    } catch (error) {
      logger.error('Get all integrations error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get integration by ID
   */
  async getIntegrationById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const integration = await accountIntegrationRepository.findOne({
        id,
        business_id: req.user.business_id
      });

      if (!integration) {
        res.status(404).json({
          success: false,
          error: 'Integration not found'
        });
        return;
      }

      const status = await integrationService.getStatus(id, req.user.business_id);

      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      logger.error('Get integration error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Connect integration
   */
  async connectIntegration(req: Request, res: Response): Promise<void> {
    try {
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'integration:create'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const {
        provider,
        accountEmail,
        accessToken,
        refreshToken,
        expiresAt,
        scopes,
        settings
      } = req.body;

      // Validate provider
      if (!Object.values(INTEGRATION_PROVIDERS).includes(provider)) {
        res.status(400).json({
          success: false,
          error: 'Invalid provider'
        });
        return;
      }

      const integration = await integrationService.connect({
        provider,
        businessId: req.user.business_id,
        accountEmail,
        accessToken,
        refreshToken,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        scopes,
        settings
      }, req.user.id);

      res.status(201).json({
        success: true,
        data: integration
      });
    } catch (error) {
      logger.error('Connect integration error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Disconnect integration
   */
  async disconnectIntegration(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'integration:delete',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      await integrationService.disconnect(id, req.user.business_id, req.user.id);

      res.json({
        success: true,
        message: 'Integration disconnected successfully'
      });
    } catch (error) {
      logger.error('Disconnect integration error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Sync integration
   */
  async syncIntegration(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'integration:update',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      // Queue sync instead of waiting
      await integrationService.queueSync(id, req.user.business_id);

      res.json({
        success: true,
        message: 'Sync queued successfully'
      });
    } catch (error) {
      logger.error('Sync integration error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update integration settings
   */
  async updateSettings(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const settings = req.body;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'integration:update',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const integration = await integrationService.updateSettings(
        id,
        req.user.business_id,
        settings,
        req.user.id
      );

      res.json({
        success: true,
        data: integration
      });
    } catch (error) {
      logger.error('Update settings error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get OAuth URL
   */
  async getOAuthURL(req: Request, res: Response): Promise<void> {
    try {
      const { provider } = req.params;

      // Generate OAuth URL based on provider
      let url = '';
      switch (provider) {
        case 'zoho':
          url = `https://accounts.zoho.com/oauth/v2/auth?scope=ZohoBooks.fullaccess.all&client_id=${process.env.ZOHO_CLIENT_ID}&response_type=code&access_type=offline&redirect_uri=${process.env.ZOHO_REDIRECT_URI}`;
          break;
        case 'quickbooks':
          url = `https://appcenter.intuit.com/connect/oauth2?client_id=${process.env.QUICKBOOKS_CLIENT_ID}&response_type=code&scope=com.intuit.quickbooks.accounting&redirect_uri=${process.env.QUICKBOOKS_REDIRECT_URI}`;
          break;
        default:
          res.status(400).json({
            success: false,
            error: 'Provider does not support OAuth'
          });
          return;
      }

      res.json({
        success: true,
        data: { url }
      });
    } catch (error) {
      logger.error('Get OAuth URL error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Handle OAuth callback
   */
  async handleOAuthCallback(req: Request, res: Response): Promise<void> {
    try {
      const { provider } = req.params;
      const { code, state, realmId } = req.query;

      // Exchange code for tokens (would be implemented per provider)
      // This is a placeholder - actual implementation would use provider-specific logic

      res.redirect(`${process.env.FRONTEND_URL}/integrations?success=true`);
    } catch (error) {
      logger.error('OAuth callback error:', error);
      res.redirect(`${process.env.FRONTEND_URL}/integrations?success=false&error=${error.message}`);
    }
  }

  /**
   * Get integration status
   */
  async getIntegrationStatus(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const status = await integrationService.getStatus(id, req.user.business_id);

      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      logger.error('Get integration status error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get provider statistics
   */
  async getProviderStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = await accountIntegrationRepository.getProviderStats(
        req.user.business_id
      );

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('Get provider stats error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get webhook endpoints
   */
  async getWebhookEndpoints(req: Request, res: Response): Promise<void> {
    try {
      const endpoints = await accountIntegrationRepository.getWebhookEndpoints(
        req.user.business_id
      );

      res.json({
        success: true,
        data: endpoints
      });
    } catch (error) {
      logger.error('Get webhook endpoints error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Test integration
   */
  async testIntegration(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const integration = await accountIntegrationRepository.findOne({
        id,
        business_id: req.user.business_id
      });

      if (!integration) {
        res.status(404).json({
          success: false,
          error: 'Integration not found'
        });
        return;
      }

      const accessToken = await accountIntegrationRepository.getAccessToken(
        id,
        req.user.business_id
      );

      if (!accessToken) {
        res.status(400).json({
          success: false,
          error: 'Unable to get access token'
        });
        return;
      }

      const provider = integrationService.getProvider(integration.provider);
      const result = await provider.testConnection(accessToken);

      res.json({
        success: result.success,
        data: result
      });
    } catch (error) {
      logger.error('Test integration error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const integrationController = new IntegrationController();

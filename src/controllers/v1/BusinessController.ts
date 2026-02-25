import { Request, Response } from 'express';
import { businessRepository } from '../../repositories/BusinessRepository';
import { userRepository } from '../../repositories/UserRepository';
import { auditLogRepository } from '../../repositories/AuditLogRepository';
import { logger } from '../../config/logger';
import { permissionService } from '../../services/auth/PermissionService';

export class BusinessController {
  /**
   * Get current business
   */
  async getCurrentBusiness(req: Request, res: Response): Promise<void> {
    try {
      const business = await businessRepository.findById(req.user.business_id);

      if (!business) {
        res.status(404).json({
          success: false,
          error: 'Business not found'
        });
        return;
      }

      res.json({
        success: true,
        data: business
      });
    } catch (error) {
      logger.error('Get current business error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update business
   */
  async updateBusiness(req: Request, res: Response): Promise<void> {
    try {
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'business:write'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const updates = req.body;

      const business = await businessRepository.update(req.user.business_id, updates);

      if (!business) {
        res.status(404).json({
          success: false,
          error: 'Business not found'
        });
        return;
      }

      // Log audit
      await auditLogRepository.log({
        user_id: req.user.id,
        business_id: req.user.business_id,
        action: 'BUSINESS_UPDATE',
        entity_type: 'business',
        entity_id: business.id,
        metadata: { updates }
      });

      res.json({
        success: true,
        data: business
      });
    } catch (error) {
      logger.error('Update business error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get business settings
   */
  async getSettings(req: Request, res: Response): Promise<void> {
    try {
      const business = await businessRepository.findById(req.user.business_id);

      if (!business) {
        res.status(404).json({
          success: false,
          error: 'Business not found'
        });
        return;
      }

      res.json({
        success: true,
        data: {
          tax_settings: business.tax_settings,
          integration_settings: business.integration_settings,
          settings: business.settings,
          invoice_prefix: business.invoice_prefix,
          default_currency: business.default_currency
        }
      });
    } catch (error) {
      logger.error('Get settings error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update settings
   */
  async updateSettings(req: Request, res: Response): Promise<void> {
    try {
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'business:write'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const { tax_settings, integration_settings, settings } = req.body;

      const business = await businessRepository.update(req.user.business_id, {
        ...(tax_settings && { tax_settings }),
        ...(integration_settings && { integration_settings }),
        ...(settings && { settings })
      });

      if (!business) {
        res.status(404).json({
          success: false,
          error: 'Business not found'
        });
        return;
      }

      res.json({
        success: true,
        data: {
          tax_settings: business.tax_settings,
          integration_settings: business.integration_settings,
          settings: business.settings
        }
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
   * Get business users
   */
  async getUsers(req: Request, res: Response): Promise<void> {
    try {
      const { role } = req.query;

      const users = await userRepository.findByBusiness(
        req.user.business_id,
        role as string
      );

      // Remove sensitive data
      const sanitizedUsers = users.map(user => {
        delete user.password_hash;
        delete user.mfa_secret;
        delete user.mfa_backup_codes;
        delete user.password_history;
        return user;
      });

      res.json({
        success: true,
        data: sanitizedUsers
      });
    } catch (error) {
      logger.error('Get business users error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get business statistics
   */
  async getStatistics(req: Request, res: Response): Promise<void> {
    try {
      const stats = await businessRepository.getStatistics();

      // Filter for current business
      const businessStats = stats.find(s => s.id === req.user.business_id);

      res.json({
        success: true,
        data: businessStats || {}
      });
    } catch (error) {
      logger.error('Get business statistics error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get FIRS status
   */
  async getFIRSStatus(req: Request, res: Response): Promise<void> {
    try {
      const business = await businessRepository.findById(req.user.business_id);

      if (!business) {
        res.status(404).json({
          success: false,
          error: 'Business not found'
        });
        return;
      }

      res.json({
        success: true,
        data: {
          status: business.firs_status,
          registered_at: business.firs_registered_at,
          csid: business.csid,
          csid_expires_at: business.csid_expires_at
        }
      });
    } catch (error) {
      logger.error('Get FIRS status error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get subscription info
   */
  async getSubscription(req: Request, res: Response): Promise<void> {
    try {
      const business = await businessRepository.findById(req.user.business_id);

      if (!business) {
        res.status(404).json({
          success: false,
          error: 'Business not found'
        });
        return;
      }

      res.json({
        success: true,
        data: {
          tier: business.subscription_tier,
          status: business.subscription_status,
          expires_at: business.subscription_expires_at,
          features: business.features
        }
      });
    } catch (error) {
      logger.error('Get subscription error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get bank details
   */
  async getBankDetails(req: Request, res: Response): Promise<void> {
    try {
      const business = await businessRepository.findById(req.user.business_id);

      if (!business) {
        res.status(404).json({
          success: false,
          error: 'Business not found'
        });
        return;
      }

      res.json({
        success: true,
        data: business.bank_details || []
      });
    } catch (error) {
      logger.error('Get bank details error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Add bank details
   */
  async addBankDetails(req: Request, res: Response): Promise<void> {
    try {
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'business:write'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const bankDetails = req.body;

      const business = await businessRepository.addBankDetails(
        req.user.business_id,
        bankDetails
      );

      res.json({
        success: true,
        data: business?.bank_details
      });
    } catch (error) {
      logger.error('Add bank details error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const businessController = new BusinessController();

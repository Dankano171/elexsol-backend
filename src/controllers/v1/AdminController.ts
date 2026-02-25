import { Request, Response } from 'express';
import { adminService } from '../../services/admin/AdminService';
import { featureFlagAdminService } from '../../services/admin/FeatureFlagAdminService';
import { systemConfigService } from '../../services/admin/SystemConfigService';
import { monitoringService } from '../../services/admin/MonitoringService';
import { healthCheckService } from '../../services/health/HealthCheckService';
import { diagnosticService } from '../../services/health/DiagnosticService';
import { performanceProfiler } from '../../services/health/PerformanceProfilerService';
import { logger } from '../../config/logger';
import { permissionService } from '../../services/auth/PermissionService';

export class AdminController {
  /**
   * Get system statistics
   */
  async getSystemStats(req: Request, res: Response): Promise<void> {
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

      const stats = await adminService.getSystemStats();

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('Get system stats error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get admin users
   */
  async getAdminUsers(req: Request, res: Response): Promise<void> {
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

      const admins = await adminService.getAdminUsers();

      res.json({
        success: true,
        data: admins
      });
    } catch (error) {
      logger.error('Get admin users error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Create admin user
   */
  async createAdminUser(req: Request, res: Response): Promise<void> {
    try {
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

      const { email, password, name, role } = req.body;

      const admin = await adminService.createAdminUser(
        email,
        password,
        name,
        role,
        req.user.id
      );

      res.status(201).json({
        success: true,
        data: admin
      });
    } catch (error) {
      logger.error('Create admin user error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update admin user
   */
  async updateAdminUser(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

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

      const admin = await adminService.updateAdminUser(
        id,
        req.body,
        req.user.id
      );

      res.json({
        success: true,
        data: admin
      });
    } catch (error) {
      logger.error('Update admin user error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Delete admin user
   */
  async deleteAdminUser(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

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

      await adminService.deleteAdminUser(id, req.user.id);

      res.json({
        success: true,
        message: 'Admin user deleted'
      });
    } catch (error) {
      logger.error('Delete admin user error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get audit logs
   */
  async getAuditLogs(req: Request, res: Response): Promise<void> {
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

      const {
        adminId,
        action,
        fromDate,
        toDate,
        page = 1,
        limit = 50
      } = req.query;

      const logs = await adminService.getAuditLogs({
        adminId: adminId as string,
        action: action as string,
        fromDate: fromDate ? new Date(fromDate as string) : undefined,
        toDate: toDate ? new Date(toDate as string) : undefined,
        limit: Number(limit),
        offset: (Number(page) - 1) * Number(limit)
      });

      res.json({
        success: true,
        data: logs
      });
    } catch (error) {
      logger.error('Get audit logs error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Suspend business
   */
  async suspendBusiness(req: Request, res: Response): Promise<void> {
    try {
      const { businessId } = req.params;
      const { reason } = req.body;

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

      await adminService.suspendBusiness(businessId, reason, req.user.id);

      res.json({
        success: true,
        message: 'Business suspended'
      });
    } catch (error) {
      logger.error('Suspend business error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Reinstate business
   */
  async reinstateBusiness(req: Request, res: Response): Promise<void> {
    try {
      const { businessId } = req.params;

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

      await adminService.reinstateBusiness(businessId, req.user.id);

      res.json({
        success: true,
        message: 'Business reinstated'
      });
    } catch (error) {
      logger.error('Reinstate business error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get all feature flags
   */
  async getAllFeatureFlags(req: Request, res: Response): Promise<void> {
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

      const flags = await featureFlagAdminService.getAllFeatureFlags();

      res.json({
        success: true,
        data: flags
      });
    } catch (error) {
      logger.error('Get feature flags error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Create feature flag
   */
  async createFeatureFlag(req: Request, res: Response): Promise<void> {
    try {
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

      const flag = await featureFlagAdminService.createFeatureFlag(
        req.body,
        req.user.id
      );

      res.status(201).json({
        success: true,
        data: flag
      });
    } catch (error) {
      logger.error('Create feature flag error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update feature flag
   */
  async updateFeatureFlag(req: Request, res: Response): Promise<void> {
    try {
      const { name } = req.params;

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

      const flag = await featureFlagAdminService.updateFeatureFlag(
        name,
        req.body,
        req.user.id
      );

      res.json({
        success: true,
        data: flag
      });
    } catch (error) {
      logger.error('Update feature flag error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Delete feature flag
   */
  async deleteFeatureFlag(req: Request, res: Response): Promise<void> {
    try {
      const { name } = req.params;

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

      await featureFlagAdminService.deleteFeatureFlag(name, req.user.id);

      res.json({
        success: true,
        message: 'Feature flag deleted'
      });
    } catch (error) {
      logger.error('Delete feature flag error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get feature flag metrics
   */
  async getFeatureFlagMetrics(req: Request, res: Response): Promise<void> {
    try {
      const { name } = req.params;

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

      const metrics = await featureFlagAdminService.getFeatureFlagMetrics(name);

      res.json({
        success: true,
        data: metrics
      });
    } catch (error) {
      logger.error('Get feature flag metrics error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get system configuration
   */
  async getSystemConfig(req: Request, res: Response): Promise<void> {
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

      const { category } = req.query;
      const configs = await systemConfigService.getAll(category as string);

      res.json({
        success: true,
        data: configs
      });
    } catch (error) {
      logger.error('Get system config error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update system configuration
   */
  async updateSystemConfig(req: Request, res: Response): Promise<void> {
    try {
      const { key } = req.params;

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

      const { value, type, description, category, reason } = req.body;

      await systemConfigService.set(key, value, {
        type,
        description,
        category,
        updatedBy: req.user.id,
        reason
      });

      res.json({
        success: true,
        message: 'Configuration updated'
      });
    } catch (error) {
      logger.error('Update system config error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get system health
   */
  async getSystemHealth(req: Request, res: Response): Promise<void> {
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

      const health = await adminService.getSystemHealth();

      res.json({
        success: true,
        data: health
      });
    } catch (error) {
      logger.error('Get system health error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Run health check
   */
  async runHealthCheck(req: Request, res: Response): Promise<void> {
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

      const { deep = false } = req.query;
      const health = await healthCheckService.runHealthCheck(deep === 'true');

      res.json({
        success: true,
        data: health
      });
    } catch (error) {
      logger.error('Run health check error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Run diagnostic
   */
  async runDiagnostic(req: Request, res: Response): Promise<void> {
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

      const { deep = false } = req.query;
      const diagnostic = await diagnosticService.runDiagnostic(deep === 'true');

      res.json({
        success: true,
        data: diagnostic
      });
    } catch (error) {
      logger.error('Run diagnostic error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get performance profiles
   */
  async getPerformanceProfiles(req: Request, res: Response): Promise<void> {
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

      const profiles = await performanceProfiler.getAllSummaries();

      res.json({
        success: true,
        data: profiles
      });
    } catch (error) {
      logger.error('Get performance profiles error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get active alerts
   */
  async getActiveAlerts(req: Request, res: Response): Promise<void> {
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

      const alerts = monitoringService.getActiveAlerts();

      res.json({
        success: true,
        data: alerts
      });
    } catch (error) {
      logger.error('Get active alerts error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get metrics history
   */
  async getMetricsHistory(req: Request, res: Response): Promise<void> {
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

      const { from, to, interval = 'hour' } = req.query;

      if (!from || !to) {
        res.status(400).json({
          success: false,
          error: 'from and to dates are required'
        });
        return;
      }

      const metrics = await monitoringService.getMetricsHistory(
        new Date(from as string),
        new Date(to as string),
        interval as any
      );

      res.json({
        success: true,
        data: metrics
      });
    } catch (error) {
      logger.error('Get metrics history error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Acknowledge alert
   */
  async acknowledgeAlert(req: Request, res: Response): Promise<void> {
    try {
      const { alertId } = req.params;

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

      monitoringService.acknowledgeAlert(alertId);

      res.json({
        success: true,
        message: 'Alert acknowledged'
      });
    } catch (error) {
      logger.error('Acknowledge alert error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Export configuration
   */
  async exportConfig(req: Request, res: Response): Promise<void> {
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

      const { includeEncrypted = false } = req.query;
      const config = await systemConfigService.exportConfig(includeEncrypted === 'true');

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=config-${new Date().toISOString()}.json`);
      res.send(JSON.stringify(config, null, 2));
    } catch (error) {
      logger.error('Export config error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Import configuration
   */
  async importConfig(req: Request, res: Response): Promise<void> {
    try {
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

      await systemConfigService.importConfig(req.body, req.user.id);

      res.json({
        success: true,
        message: 'Configuration imported successfully'
      });
    } catch (error) {
      logger.error('Import config error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const adminController = new AdminController();

import { Request, Response, NextFunction } from 'express';
import { permissionService } from '../services/auth/PermissionService';
import { logger } from '../config/logger';

export const authorize = (requiredPermission: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      // Super admin has all permissions
      if (req.user.role === 'super_admin') {
        return next();
      }

      // Check permission
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        requiredPermission,
        req.params.id // Resource ID for resource-specific permissions
      );

      if (!hasPermission) {
        logger.warn('Authorization failed', {
          userId: req.user.id,
          requiredPermission,
          resourceId: req.params.id
        });

        return res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
      }

      next();
    } catch (error) {
      logger.error('Authorization error:', error);
      return res.status(500).json({
        success: false,
        error: 'Authorization check failed'
      });
    }
  };
};

/**
 * Check if user has any of the required permissions
 */
export const authorizeAny = (requiredPermissions: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      if (req.user.role === 'super_admin') {
        return next();
      }

      for (const permission of requiredPermissions) {
        const hasPermission = await permissionService.hasPermission(
          req.user.id,
          permission,
          req.params.id
        );

        if (hasPermission) {
          return next();
        }
      }

      logger.warn('Authorization failed (any)', {
        userId: req.user.id,
        requiredPermissions,
        resourceId: req.params.id
      });

      return res.status(403).json({
        success: false,
        error: 'Insufficient permissions'
      });
    } catch (error) {
      logger.error('Authorization error:', error);
      return res.status(500).json({
        success: false,
        error: 'Authorization check failed'
      });
    }
  };
};

/**
 * Check if user has all required permissions
 */
export const authorizeAll = (requiredPermissions: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      if (req.user.role === 'super_admin') {
        return next();
      }

      for (const permission of requiredPermissions) {
        const hasPermission = await permissionService.hasPermission(
          req.user.id,
          permission,
          req.params.id
        );

        if (!hasPermission) {
          logger.warn('Authorization failed (all)', {
            userId: req.user.id,
            failedPermission: permission,
            resourceId: req.params.id
          });

          return res.status(403).json({
            success: false,
            error: 'Insufficient permissions'
          });
        }
      }

      next();
    } catch (error) {
      logger.error('Authorization error:', error);
      return res.status(500).json({
        success: false,
        error: 'Authorization check failed'
      });
    }
  };
};

/**
 * Role-based authorization
 */
export const authorizeRole = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      if (allowedRoles.includes(req.user.role)) {
        return next();
      }

      logger.warn('Role authorization failed', {
        userId: req.user.id,
        userRole: req.user.role,
        allowedRoles
      });

      return res.status(403).json({
        success: false,
        error: 'Insufficient role permissions'
      });
    } catch (error) {
      logger.error('Role authorization error:', error);
      return res.status(500).json({
        success: false,
        error: 'Authorization check failed'
      });
    }
  };
};

/**
 * Check if user owns the resource
 */
export const authorizeOwner = (resourceType: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      const resourceId = req.params.id;

      if (!resourceId) {
        return res.status(400).json({
          success: false,
          error: 'Resource ID required'
        });
      }

      // Check ownership based on resource type
      let isOwner = false;

      switch (resourceType) {
        case 'invoice':
          // Check if invoice belongs to user's business
          const invoice = await invoiceRepository.findOne({
            id: resourceId,
            business_id: req.user.business_id
          });
          isOwner = !!invoice;
          break;

        case 'user':
          isOwner = resourceId === req.user.id;
          break;

        case 'integration':
          const integration = await accountIntegrationRepository.findOne({
            id: resourceId,
            business_id: req.user.business_id
          });
          isOwner = !!integration;
          break;

        default:
          isOwner = false;
      }

      if (isOwner || req.user.role === 'super_admin') {
        return next();
      }

      logger.warn('Owner authorization failed', {
        userId: req.user.id,
        resourceType,
        resourceId
      });

      return res.status(403).json({
        success: false,
        error: 'You do not own this resource'
      });
    } catch (error) {
      logger.error('Owner authorization error:', error);
      return res.status(500).json({
        success: false,
        error: 'Authorization check failed'
      });
    }
  };
};

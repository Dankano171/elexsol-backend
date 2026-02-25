import { Request, Response } from 'express';
import { userRepository } from '../../repositories/UserRepository';
import { auditLogRepository } from '../../repositories/AuditLogRepository';
import { logger } from '../../config/logger';
import { permissionService } from '../../services/auth/PermissionService';

export class UserController {
  /**
   * Get all users (admin only)
   */
  async getAllUsers(req: Request, res: Response): Promise<void> {
    try {
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'user:read'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const { page = 1, limit = 20, role, businessId } = req.query;

      const users = await userRepository.paginate(
        { 
          ...(role && { role }),
          ...(businessId && { business_id: businessId })
        },
        Number(page),
        Number(limit),
        'created_at',
        'DESC'
      );

      res.json({
        success: true,
        data: users
      });
    } catch (error) {
      logger.error('Get all users error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get user by ID
   */
  async getUserById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Check permission
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'user:read',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const user = await userRepository.findById(id);

      if (!user) {
        res.status(404).json({
          success: false,
          error: 'User not found'
        });
        return;
      }

      // Remove sensitive data
      delete user.password_hash;
      delete user.mfa_secret;
      delete user.mfa_backup_codes;
      delete user.password_history;

      res.json({
        success: true,
        data: user
      });
    } catch (error) {
      logger.error('Get user by ID error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Create user
   */
  async createUser(req: Request, res: Response): Promise<void> {
    try {
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'user:create'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const userData = req.body;

      const user = await userRepository.createUser(userData, req.user.id);

      res.status(201).json({
        success: true,
        data: user
      });
    } catch (error) {
      logger.error('Create user error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update user
   */
  async updateUser(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'user:update',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const updates = req.body;

      // Prevent updating sensitive fields
      delete updates.password_hash;
      delete updates.mfa_secret;
      delete updates.mfa_backup_codes;
      delete updates.password_history;

      const user = await userRepository.update(id, updates);

      if (!user) {
        res.status(404).json({
          success: false,
          error: 'User not found'
        });
        return;
      }

      // Log audit
      await auditLogRepository.log({
        user_id: req.user.id,
        business_id: req.user.business_id,
        action: 'USER_UPDATE',
        entity_type: 'user',
        entity_id: id,
        metadata: { updates }
      });

      res.json({
        success: true,
        data: user
      });
    } catch (error) {
      logger.error('Update user error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Delete user
   */
  async deleteUser(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'user:delete',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const deleted = await userRepository.softDelete(id);

      if (!deleted) {
        res.status(404).json({
          success: false,
          error: 'User not found'
        });
        return;
      }

      // Log audit
      await auditLogRepository.log({
        user_id: req.user.id,
        business_id: req.user.business_id,
        action: 'USER_DELETE',
        entity_type: 'user',
        entity_id: id,
        metadata: {}
      });

      res.json({
        success: true,
        message: 'User deleted successfully'
      });
    } catch (error) {
      logger.error('Delete user error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update user permissions
   */
  async updatePermissions(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { permissions } = req.body;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'user:update'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const user = await userRepository.update(id, { permissions });

      if (!user) {
        res.status(404).json({
          success: false,
          error: 'User not found'
        });
        return;
      }

      res.json({
        success: true,
        data: { permissions: user.permissions }
      });
    } catch (error) {
      logger.error('Update permissions error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Search users
   */
  async searchUsers(req: Request, res: Response): Promise<void> {
    try {
      const { q } = req.query;
      const { businessId } = req.user;

      if (!q || typeof q !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Search query required'
        });
        return;
      }

      const users = await userRepository.search(q, businessId);

      res.json({
        success: true,
        data: users
      });
    } catch (error) {
      logger.error('Search users error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get user statistics
   */
  async getUserStats(req: Request, res: Response): Promise<void> {
    try {
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'user:read'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const stats = await userRepository.getUserStatistics(req.user.business_id);

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('Get user stats error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const userController = new UserController();

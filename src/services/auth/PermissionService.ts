import { userRepository } from '../../repositories/UserRepository';
import { featureFlagModel } from '../../models/FeatureFlag';
import { logger } from '../../config/logger';

export interface Permission {
  resource: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'manage';
  conditions?: Record<string, any>;
}

export class PermissionService {
  private readonly rolePermissions: Record<string, string[]> = {
    super_admin: ['*'],
    admin: [
      'business:read',
      'business:write',
      'user:read',
      'user:write',
      'invoice:read',
      'invoice:write',
      'integration:read',
      'integration:write',
      'report:read',
      'report:write',
      'settings:read',
      'settings:write',
    ],
    owner: [
      'business:read',
      'business:write',
      'user:read',
      'user:write',
      'invoice:*',
      'integration:*',
      'report:*',
      'settings:read',
      'settings:write',
    ],
    manager: [
      'invoice:read',
      'invoice:write',
      'integration:read',
      'report:read',
      'customer:read',
      'customer:write',
    ],
    staff: [
      'invoice:create',
      'invoice:read',
      'customer:read',
    ],
  };

  /**
   * Check if user has permission
   */
  async hasPermission(
    userId: string,
    requiredPermission: string,
    resourceId?: string
  ): Promise<boolean> {
    try {
      const user = await userRepository.findById(userId);
      
      if (!user) {
        return false;
      }

      // Super admin has all permissions
      if (user.role === 'super_admin') {
        return true;
      }

      // Get user permissions
      const permissions = await this.getUserPermissions(userId);

      // Check for wildcard
      if (permissions.includes('*')) {
        return true;
      }

      // Check for exact match
      if (permissions.includes(requiredPermission)) {
        return true;
      }

      // Check for wildcard segments (e.g., 'invoice:*' matches 'invoice:create')
      for (const permission of permissions) {
        if (permission.endsWith(':*')) {
          const prefix = permission.replace(':*', '');
          if (requiredPermission.startsWith(prefix)) {
            return true;
          }
        }
      }

      // Check resource-specific conditions
      if (resourceId) {
        return await this.checkResourcePermission(
          userId,
          requiredPermission,
          resourceId
        );
      }

      return false;
    } catch (error) {
      logger.error('Permission check error:', error);
      return false;
    }
  }

  /**
   * Check if user has any of the permissions
   */
  async hasAnyPermission(
    userId: string,
    permissions: string[]
  ): Promise<boolean> {
    for (const permission of permissions) {
      if (await this.hasPermission(userId, permission)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if user has all permissions
   */
  async hasAllPermissions(
    userId: string,
    permissions: string[]
  ): Promise<boolean> {
    for (const permission of permissions) {
      if (!(await this.hasPermission(userId, permission))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get user permissions
   */
  async getUserPermissions(userId: string): Promise<string[]> {
    const user = await userRepository.findById(userId);
    
    if (!user) {
      return [];
    }

    // Get role-based permissions
    const rolePerms = this.rolePermissions[user.role] || [];
    
    // Combine with custom permissions
    const allPerms = [...new Set([...rolePerms, ...(user.permissions || [])])];

    // Filter out any permissions that require feature flags
    return this.filterFeaturePermissions(user.business_id, allPerms);
  }

  /**
   * Get users with permission
   */
  async getUsersWithPermission(
    businessId: string,
    permission: string
  ): Promise<any[]> {
    const users = await userRepository.findByBusiness(businessId);
    
    const hasPermission = await Promise.all(
      users.map(async user => ({
        user,
        hasPermission: await this.hasPermission(user.id, permission),
      }))
    );

    return hasPermission
      .filter(item => item.hasPermission)
      .map(item => item.user);
  }

  /**
   * Grant permission to user
   */
  async grantPermission(
    userId: string,
    permission: string,
    grantedBy: string
  ): Promise<void> {
    const user = await userRepository.findById(userId);
    
    if (!user) {
      throw new Error('User not found');
    }

    const permissions = [...(user.permissions || []), permission];
    
    await userRepository.update(userId, {
      permissions: [...new Set(permissions)],
    });

    // Log audit
    await auditLogRepository.log({
      user_id: grantedBy,
      business_id: user.business_id,
      action: 'PERMISSION_GRANT',
      entity_type: 'user',
      entity_id: userId,
      metadata: {
        permission,
      },
    });
  }

  /**
   * Revoke permission from user
   */
  async revokePermission(
    userId: string,
    permission: string,
    revokedBy: string
  ): Promise<void> {
    const user = await userRepository.findById(userId);
    
    if (!user) {
      throw new Error('User not found');
    }

    const permissions = (user.permissions || []).filter(p => p !== permission);
    
    await userRepository.update(userId, {
      permissions,
    });

    // Log audit
    await auditLogRepository.log({
      user_id: revokedBy,
      business_id: user.business_id,
      action: 'PERMISSION_REVOKE',
      entity_type: 'user',
      entity_id: userId,
      metadata: {
        permission,
      },
    });
  }

  /**
   * Check resource-specific permission
   */
  private async checkResourcePermission(
    userId: string,
    permission: string,
    resourceId: string
  ): Promise<boolean> {
    const [resource] = permission.split(':');

    switch (resource) {
      case 'invoice':
        return this.checkInvoicePermission(userId, resourceId, permission);
      case 'customer':
        return this.checkCustomerPermission(userId, resourceId, permission);
      case 'integration':
        return this.checkIntegrationPermission(userId, resourceId, permission);
      default:
        return false;
    }
  }

  /**
   * Check invoice permission
   */
  private async checkInvoicePermission(
    userId: string,
    invoiceId: string,
    permission: string
  ): Promise<boolean> {
    const user = await userRepository.findById(userId);
    if (!user) return false;

    // Check if user owns the invoice
    const invoice = await invoiceRepository.findById(invoiceId);
    if (!invoice) return false;

    return invoice.business_id === user.business_id;
  }

  /**
   * Check customer permission
   */
  private async checkCustomerPermission(
    userId: string,
    customerId: string,
    permission: string
  ): Promise<boolean> {
    const user = await userRepository.findById(userId);
    if (!user) return false;

    // Check if customer belongs to user's business
    const invoices = await invoiceRepository.findByCustomer(customerId, user.business_id);
    return invoices.length > 0;
  }

  /**
   * Check integration permission
   */
  private async checkIntegrationPermission(
    userId: string,
    integrationId: string,
    permission: string
  ): Promise<boolean> {
    const user = await userRepository.findById(userId);
    if (!user) return false;

    const integration = await accountIntegrationRepository.findById(integrationId);
    if (!integration) return false;

    return integration.business_id === user.business_id;
  }

  /**
   * Filter permissions based on feature flags
   */
  private async filterFeaturePermissions(
    businessId: string,
    permissions: string[]
  ): Promise<string[]> {
    const featureMap: Record<string, string> = {
      'integration:': 'integrations',
      'api:': 'api-access',
      'report:advanced': 'advanced-reporting',
      'white-label': 'white-label',
    };

    const filtered: string[] = [];

    for (const permission of permissions) {
      let allowed = true;

      // Check each feature dependency
      for (const [prefix, feature] of Object.entries(featureMap)) {
        if (permission.startsWith(prefix)) {
          const isEnabled = await featureFlagModel.isEnabledForBusiness(
            feature as any,
            businessId
          );
          if (!isEnabled) {
            allowed = false;
            break;
          }
        }
      }

      if (allowed) {
        filtered.push(permission);
      }
    }

    return filtered;
  }
}

export const permissionService = new PermissionService();

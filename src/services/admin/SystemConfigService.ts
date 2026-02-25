import { redis } from '../../config/redis';
import { auditLogRepository } from '../../repositories/AuditLogRepository';
import { logger } from '../../config/logger';
import { encrypt, decrypt } from '../../config/encryption';

export interface SystemConfig {
  id: string;
  key: string;
  value: any;
  type: 'string' | 'number' | 'boolean' | 'json' | 'encrypted';
  description?: string;
  category: 'system' | 'security' | 'integrations' | 'notifications' | 'billing';
  mutable: boolean;
  updatedAt: Date;
  updatedBy?: string;
}

export interface ConfigChange {
  id: string;
  configKey: string;
  oldValue: any;
  newValue: any;
  changedBy: string;
  changedAt: Date;
  reason?: string;
}

export class SystemConfigService {
  private readonly configPrefix = 'config:';
  private readonly changeLogPrefix = 'config:change:';
  private readonly cacheTTL = 3600; // 1 hour

  /**
   * Get configuration value
   */
  async get<T = any>(key: string, defaultValue?: T): Promise<T> {
    try {
      // Try cache first
      const cached = await redis.get(`${this.configPrefix}${key}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        return this.decodeValue(parsed.value, parsed.type) as T;
      }

      // Get from database
      const config = await this.getFromDatabase(key);
      if (config) {
        // Cache for next time
        await redis.setex(
          `${this.configPrefix}${key}`,
          this.cacheTTL,
          JSON.stringify({
            value: config.value,
            type: config.type
          })
        );
        return this.decodeValue(config.value, config.type) as T;
      }

      return defaultValue as T;
    } catch (error) {
      logger.error(`Error getting config ${key}:`, error);
      return defaultValue as T;
    }
  }

  /**
   * Set configuration value
   */
  async set(
    key: string,
    value: any,
    options?: {
      type?: 'string' | 'number' | 'boolean' | 'json' | 'encrypted';
      description?: string;
      category?: SystemConfig['category'];
      mutable?: boolean;
      updatedBy?: string;
      reason?: string;
    }
  ): Promise<void> {
    try {
      const config = await this.getFromDatabase(key);
      const oldValue = config?.value;

      // Check if mutable
      if (config && !config.mutable) {
        throw new Error(`Configuration ${key} is immutable`);
      }

      const encodedValue = this.encodeValue(value, options?.type);

      // Store in database (simplified - would use actual repository)
      await this.saveToDatabase({
        key,
        value: encodedValue,
        type: options?.type || this.inferType(value),
        description: options?.description,
        category: options?.category || 'system',
        mutable: options?.mutable ?? true,
        updatedAt: new Date(),
        updatedBy: options?.updatedBy
      });

      // Clear cache
      await redis.del(`${this.configPrefix}${key}`);

      // Log change
      if (options?.updatedBy) {
        await this.logChange({
          configKey: key,
          oldValue,
          newValue: value,
          changedBy: options.updatedBy,
          changedAt: new Date(),
          reason: options.reason
        });
      }

      logger.info('Configuration updated', { key, updatedBy: options?.updatedBy });
    } catch (error) {
      logger.error(`Error setting config ${key}:`, error);
      throw error;
    }
  }

  /**
   * Get all configurations
   */
  async getAll(category?: string): Promise<SystemConfig[]> {
    // In production, query from database
    // Placeholder implementation
    return [];
  }

  /**
   * Delete configuration
   */
  async delete(key: string, deletedBy: string, reason?: string): Promise<void> {
    try {
      const config = await this.getFromDatabase(key);
      if (!config) {
        throw new Error(`Configuration ${key} not found`);
      }

      if (!config.mutable) {
        throw new Error(`Configuration ${key} is immutable`);
      }

      // Delete from database
      await this.deleteFromDatabase(key);

      // Clear cache
      await redis.del(`${this.configPrefix}${key}`);

      // Log deletion
      await auditLogRepository.log({
        user_id: deletedBy,
        action: 'CONFIG_DELETE',
        entity_type: 'config',
        entity_id: key,
        metadata: { reason }
      });

      logger.info('Configuration deleted', { key, deletedBy });
    } catch (error) {
      logger.error(`Error deleting config ${key}:`, error);
      throw error;
    }
  }

  /**
   * Get configuration history
   */
  async getHistory(key: string, limit: number = 10): Promise<ConfigChange[]> {
    const pattern = `${this.changeLogPrefix}${key}:*`;
    const keys = await redis.keys(pattern);
    const changes: ConfigChange[] = [];

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        changes.push(JSON.parse(data));
      }
    }

    return changes
      .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime())
      .slice(0, limit);
  }

  /**
   * Reset to default
   */
  async resetToDefault(key: string, resetBy: string): Promise<void> {
    const defaultValue = await this.getDefault(key);
    if (defaultValue !== undefined) {
      await this.set(key, defaultValue, {
        updatedBy: resetBy,
        reason: 'Reset to default'
      });
    }
  }

  /**
   * Get system defaults
   */
  async getDefaults(): Promise<Record<string, any>> {
    return {
      // System
      'system.name': 'Elexsol Gateway',
      'system.timezone': 'Africa/Lagos',
      'system.locale': 'en-NG',
      
      // Security
      'security.mfa_required': false,
      'security.session_timeout': 3600,
      'security.max_login_attempts': 5,
      'security.password_min_length': 8,
      'security.password_require_special': true,
      
      // Integrations
      'integrations.webhook_retry_attempts': 3,
      'integrations.webhook_retry_delay': 5000,
      'integrations.sync_interval': 3600,
      
      // Notifications
      'notifications.email_enabled': true,
      'notifications.sms_enabled': false,
      'notifications.push_enabled': true,
      'notifications.digest_frequency': 'daily',
      
      // Billing
      'billing.currency': 'NGN',
      'billing.tax_rate': 7.5,
      'billing.invoice_prefix': 'INV'
    };
  }

  /**
   * Get default value
   */
  private async getDefault(key: string): Promise<any> {
    const defaults = await this.getDefaults();
    return defaults[key];
  }

  /**
   * Get from database
   */
  private async getFromDatabase(key: string): Promise<SystemConfig | null> {
    // In production, query from database
    // Placeholder implementation
    return null;
  }

  /**
   * Save to database
   */
  private async saveToDatabase(config: Partial<SystemConfig>): Promise<void> {
    // In production, save to database
    // Placeholder implementation
  }

  /**
   * Delete from database
   */
  private async deleteFromDatabase(key: string): Promise<void> {
    // In production, delete from database
    // Placeholder implementation
  }

  /**
   * Log configuration change
   */
  private async logChange(change: ConfigChange): Promise<void> {
    const key = `${this.changeLogPrefix}${change.configKey}:${Date.now()}`;
    await redis.setex(key, 86400 * 30, JSON.stringify(change));

    // Also log to audit
    await auditLogRepository.log({
      user_id: change.changedBy,
      action: 'CONFIG_CHANGE',
      entity_type: 'config',
      entity_id: change.configKey,
      metadata: {
        oldValue: change.oldValue,
        newValue: change.newValue,
        reason: change.reason
      }
    });
  }

  /**
   * Encode value based on type
   */
  private encodeValue(value: any, type?: string): any {
    const actualType = type || this.inferType(value);

    switch (actualType) {
      case 'encrypted':
        return encrypt(JSON.stringify(value));
      case 'json':
        return JSON.stringify(value);
      default:
        return value;
    }
  }

  /**
   * Decode value based on type
   */
  private decodeValue(value: any, type: string): any {
    switch (type) {
      case 'encrypted':
        return JSON.parse(decrypt(value).toString());
      case 'json':
        return JSON.parse(value);
      case 'number':
        return Number(value);
      case 'boolean':
        return Boolean(value);
      default:
        return value;
    }
  }

  /**
   * Infer value type
   */
  private inferType(value: any): string {
    if (value === null) return 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'object') return 'json';
    return 'string';
  }

  /**
   * Validate configuration
   */
  async validateConfig(key: string, value: any): Promise<{ valid: boolean; error?: string }> {
    // Add validation rules per key
    const validators: Record<string, (val: any) => boolean> = {
      'security.session_timeout': (val) => val >= 300 && val <= 86400,
      'security.max_login_attempts': (val) => val >= 1 && val <= 10,
      'security.password_min_length': (val) => val >= 6 && val <= 32,
      'billing.tax_rate': (val) => val >= 0 && val <= 100
    };

    const validator = validators[key];
    if (validator && !validator(value)) {
      return {
        valid: false,
        error: `Invalid value for ${key}`
      };
    }

    return { valid: true };
  }

  /**
   * Export configuration
   */
  async exportConfig(includeEncrypted: boolean = false): Promise<any> {
    const configs = await this.getAll();
    
    return {
      exportedAt: new Date().toISOString(),
      version: '1.0',
      configs: configs
        .filter(c => includeEncrypted || c.type !== 'encrypted')
        .map(c => ({
          key: c.key,
          value: c.type === 'encrypted' ? '[ENCRYPTED]' : c.value,
          type: c.type,
          description: c.description,
          category: c.category,
          updatedAt: c.updatedAt
        }))
    };
  }

  /**
   * Import configuration
   */
  async importConfig(config: any, importedBy: string): Promise<void> {
    for (const item of config.configs) {
      try {
        // Validate before importing
        const validation = await this.validateConfig(item.key, item.value);
        if (!validation.valid) {
          logger.warn(`Skipping invalid config ${item.key}: ${validation.error}`);
          continue;
        }

        await this.set(item.key, item.value, {
          type: item.type,
          description: item.description,
          category: item.category,
          updatedBy: importedBy,
          reason: 'Configuration import'
        });
      } catch (error) {
        logger.error(`Error importing config ${item.key}:`, error);
      }
    }
  }
}

export const systemConfigService = new SystemConfigService();

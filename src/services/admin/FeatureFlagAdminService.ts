import { featureFlagModel } from '../../models/FeatureFlag';
import { businessRepository } from '../../repositories/BusinessRepository';
import { auditLogRepository } from '../../repositories/AuditLogRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';

export interface FeatureFlagDefinition {
  name: string;
  description: string;
  enabled: boolean;
  global: boolean;
  businessIds?: string[];
  subscriptionTiers?: string[];
  percentageRollout?: number;
  startDate?: Date;
  endDate?: Date;
  maxUsage?: number;
  dependsOn?: string[];
  settings?: Record<string, any>;
}

export interface FeatureFlagMetrics {
  name: string;
  enabled: boolean;
  totalBusinesses: number;
  activeBusinesses: number;
  usageCount: number;
  usagePercentage: number;
  remainingQuota: number | null;
  averageUsagePerBusiness: number;
  topUsers: Array<{
    businessId: string;
    businessName: string;
    usageCount: number;
  }>;
}

export class FeatureFlagAdminService {
  /**
   * Create feature flag
   */
  async createFeatureFlag(
    flag: FeatureFlagDefinition,
    createdBy: string
  ): Promise<any> {
    try {
      // Check if exists
      const existing = await featureFlagModel.findOne({ name: flag.name });
      if (existing) {
        throw new Error(`Feature flag ${flag.name} already exists`);
      }

      const created = await featureFlagModel.createFeature({
        name: flag.name as any,
        description: flag.description,
        enabled: flag.enabled,
        global: flag.global,
        business_ids: flag.businessIds,
        subscription_tiers: flag.subscriptionTiers,
        percentage_rollout: flag.percentageRollout,
        start_date: flag.startDate,
        end_date: flag.endDate,
        max_usage: flag.maxUsage,
        depends_on: flag.dependsOn as any[],
        settings: flag.settings || {},
        created_by: createdBy
      });

      // Clear cache
      await this.clearFeatureCache(flag.name);

      // Log audit
      await auditLogRepository.log({
        user_id: createdBy,
        action: 'FEATURE_FLAG_CREATE',
        entity_type: 'feature_flag',
        entity_id: created.id,
        metadata: { flag: flag.name }
      });

      logger.info('Feature flag created', { flag: flag.name });

      return created;
    } catch (error) {
      logger.error('Error creating feature flag:', error);
      throw error;
    }
  }

  /**
   * Update feature flag
   */
  async updateFeatureFlag(
    name: string,
    updates: Partial<FeatureFlagDefinition>,
    updatedBy: string
  ): Promise<any> {
    try {
      const flag = await featureFlagModel.findOne({ name });
      if (!flag) {
        throw new Error(`Feature flag ${name} not found`);
      }

      const updated = await featureFlagModel.update(flag.id, {
        description: updates.description,
        enabled: updates.enabled,
        global: updates.global,
        business_ids: updates.businessIds,
        subscription_tiers: updates.subscriptionTiers,
        percentage_rollout: updates.percentageRollout,
        start_date: updates.startDate,
        end_date: updates.endDate,
        max_usage: updates.maxUsage,
        depends_on: updates.dependsOn,
        settings: updates.settings,
        updated_by: updatedBy
      });

      // Clear cache
      await this.clearFeatureCache(name);

      // Log audit
      await auditLogRepository.log({
        user_id: updatedBy,
        action: 'FEATURE_FLAG_UPDATE',
        entity_type: 'feature_flag',
        entity_id: flag.id,
        metadata: { flag: name, updates }
      });

      logger.info('Feature flag updated', { flag: name });

      return updated;
    } catch (error) {
      logger.error('Error updating feature flag:', error);
      throw error;
    }
  }

  /**
   * Delete feature flag
   */
  async deleteFeatureFlag(name: string, deletedBy: string): Promise<void> {
    try {
      const flag = await featureFlagModel.findOne({ name });
      if (!flag) {
        throw new Error(`Feature flag ${name} not found`);
      }

      await featureFlagModel.hardDelete(flag.id);

      // Clear cache
      await this.clearFeatureCache(name);

      // Log audit
      await auditLogRepository.log({
        user_id: deletedBy,
        action: 'FEATURE_FLAG_DELETE',
        entity_type: 'feature_flag',
        entity_id: flag.id,
        metadata: { flag: name }
      });

      logger.info('Feature flag deleted', { flag: name });
    } catch (error) {
      logger.error('Error deleting feature flag:', error);
      throw error;
    }
  }

  /**
   * Get all feature flags
   */
  async getAllFeatureFlags(): Promise<any[]> {
    return featureFlagModel.find({}, {
      orderBy: 'name',
      orderDir: 'ASC'
    });
  }

  /**
   * Get feature flag metrics
   */
  async getFeatureFlagMetrics(name: string): Promise<FeatureFlagMetrics> {
    const flag = await featureFlagModel.findOne({ name });
    if (!flag) {
      throw new Error(`Feature flag ${name} not found`);
    }

    const usageStats = await featureFlagModel.getUsageStats(name as any);

    // Get businesses using this feature
    const businesses = flag.business_ids || [];
    const businessesWithNames = await Promise.all(
      businesses.slice(0, 10).map(async id => {
        const business = await businessRepository.findById(id);
        return {
          businessId: id,
          businessName: business?.name || 'Unknown',
          usageCount: 0 // Would need actual usage tracking
        };
      })
    );

    return {
      name: flag.name,
      enabled: flag.enabled,
      totalBusinesses: businesses.length,
      activeBusinesses: businesses.length,
      usageCount: usageStats?.current_usage || 0,
      usagePercentage: usageStats?.usage_percentage || 0,
      remainingQuota: usageStats?.max_usage ? usageStats.max_usage - usageStats.current_usage : null,
      averageUsagePerBusiness: businesses.length > 0 
        ? (usageStats?.current_usage || 0) / businesses.length 
        : 0,
      topUsers: businessesWithNames
    };
  }

  /**
   * Enable feature for business
   */
  async enableForBusiness(
    featureName: string,
    businessId: string,
    enabledBy: string
  ): Promise<void> {
    const flag = await featureFlagModel.findOne({ name: featureName });
    if (!flag) {
      throw new Error(`Feature flag ${featureName} not found`);
    }

    await featureFlagModel.enableForBusiness(featureName as any, businessId);

    // Clear cache
    await this.clearFeatureCache(featureName);
    await this.clearBusinessCache(businessId);

    // Log audit
    await auditLogRepository.log({
      user_id: enabledBy,
      action: 'FEATURE_ENABLE',
      entity_type: 'feature_flag',
      entity_id: flag.id,
      metadata: { feature: featureName, businessId }
    });
  }

  /**
   * Disable feature for business
   */
  async disableForBusiness(
    featureName: string,
    businessId: string,
    disabledBy: string
  ): Promise<void> {
    const flag = await featureFlagModel.findOne({ name: featureName });
    if (!flag) {
      throw new Error(`Feature flag ${featureName} not found`);
    }

    await featureFlagModel.disableForBusiness(featureName as any, businessId);

    // Clear cache
    await this.clearFeatureCache(featureName);
    await this.clearBusinessCache(businessId);

    // Log audit
    await auditLogRepository.log({
      user_id: disabledBy,
      action: 'FEATURE_DISABLE',
      entity_type: 'feature_flag',
      entity_id: flag.id,
      metadata: { feature: featureName, businessId }
    });
  }

  /**
   * Bulk update for subscription tier
   */
  async updateForSubscriptionTier(
    tier: string,
    features: string[],
    enabled: boolean,
    updatedBy: string
  ): Promise<number> {
    const count = await featureFlagModel.updateForSubscriptionTier(
      tier,
      features as any[],
      enabled
    );

    // Clear all feature caches
    for (const feature of features) {
      await this.clearFeatureCache(feature);
    }

    // Log audit
    await auditLogRepository.log({
      user_id: updatedBy,
      action: 'FEATURE_BULK_UPDATE',
      entity_type: 'feature_flag',
      metadata: { tier, features, enabled, count }
    });

    return count;
  }

  /**
   * Get rollout progress
   */
  async getRolloutProgress(featureName: string): Promise<any> {
    return featureFlagModel.getRolloutProgress(featureName as any);
  }

  /**
   * Validate dependencies
   */
  async validateDependencies(featureName: string): Promise<any> {
    return featureFlagModel.validateDependencies(featureName as any);
  }

  /**
   * Get expiring features
   */
  async getExpiringFeatures(days: number = 7): Promise<any[]> {
    return featureFlagModel.getExpiring(days);
  }

  /**
   * Clear feature cache
   */
  private async clearFeatureCache(featureName: string): Promise<void> {
    const pattern = `*:${featureName}:*`;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  /**
   * Clear business cache
   */
  private async clearBusinessCache(businessId: string): Promise<void> {
    const pattern = `*:${businessId}:*`;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  /**
   * Export feature flag configuration
   */
  async exportConfig(): Promise<any> {
    const flags = await this.getAllFeatureFlags();
    
    return {
      exportedAt: new Date().toISOString(),
      version: '1.0',
      flags: flags.map(f => ({
        name: f.name,
        description: f.description,
        enabled: f.enabled,
        global: f.global,
        subscriptionTiers: f.subscription_tiers,
        percentageRollout: f.percentage_rollout,
        startDate: f.start_date,
        endDate: f.end_date,
        maxUsage: f.max_usage,
        dependsOn: f.depends_on,
        settings: f.settings
      }))
    };
  }

  /**
   * Import feature flag configuration
   */
  async importConfig(config: any, importedBy: string): Promise<void> {
    for (const flag of config.flags) {
      try {
        const existing = await featureFlagModel.findOne({ name: flag.name });
        
        if (existing) {
          await this.updateFeatureFlag(flag.name, flag, importedBy);
        } else {
          await this.createFeatureFlag(flag, importedBy);
        }
      } catch (error) {
        logger.error(`Error importing flag ${flag.name}:`, error);
      }
    }

    logger.info('Feature flag configuration imported', {
      count: config.flags.length,
      importedBy
    });
  }
}

export const featureFlagAdminService = new FeatureFlagAdminService();

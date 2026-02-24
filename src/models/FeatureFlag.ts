import { BaseModel, BaseEntity } from './BaseModel';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { Feature } from '../config/constants/business-rules';

export interface FeatureFlag extends BaseEntity {
  name: Feature;
  description: string;
  enabled: boolean;
  global: boolean; // If true, applies to all businesses
  
  // Targeting
  business_ids?: string[]; // Specific businesses if not global
  subscription_tiers?: string[]; // Subscription tiers that get this feature
  percentage_rollout?: number; // 0-100 for gradual rollout
  
  // Constraints
  start_date?: Date;
  end_date?: Date;
  max_usage?: number; // Maximum times this feature can be used
  current_usage?: number;
  
  // Dependencies
  depends_on?: Feature[]; // Features that must be enabled for this to work
  
  // Settings
  settings: Record<string, any>;
  
  // Audit
  created_by?: string;
  updated_by?: string;
}

export interface CreateFeatureFlagDTO {
  name: Feature;
  description: string;
  enabled?: boolean;
  global?: boolean;
  business_ids?: string[];
  subscription_tiers?: string[];
  percentage_rollout?: number;
  start_date?: Date;
  end_date?: Date;
  max_usage?: number;
  depends_on?: Feature[];
  settings?: Record<string, any>;
  created_by?: string;
}

export class FeatureFlagModel extends BaseModel<FeatureFlag> {
  protected tableName = 'feature_flags';
  protected primaryKey = 'id';

  /**
   * Create a new feature flag
   */
  async createFeature(data: CreateFeatureFlagDTO): Promise<FeatureFlag> {
    // Check if feature already exists
    const existing = await this.findOne({ name: data.name });
    if (existing) {
      throw new Error(`Feature flag ${data.name} already exists`);
    }

    return this.create({
      ...data,
      enabled: data.enabled ?? false,
      global: data.global ?? false,
      current_usage: 0,
      settings: data.settings || {},
    });
  }

  /**
   * Check if feature is enabled for business
   */
  async isEnabledForBusiness(
    featureName: Feature,
    businessId: string,
    subscriptionTier?: string
  ): Promise<boolean> {
    const feature = await this.findOne({ name: featureName });
    
    if (!feature || !feature.enabled) {
      return false;
    }

    // Check date constraints
    const now = new Date();
    if (feature.start_date && feature.start_date > now) {
      return false;
    }
    if (feature.end_date && feature.end_date < now) {
      return false;
    }

    // Check usage limit
    if (feature.max_usage && feature.current_usage && feature.current_usage >= feature.max_usage) {
      return false;
    }

    // Global feature
    if (feature.global) {
      return true;
    }

    // Check specific businesses
    if (feature.business_ids && feature.business_ids.includes(businessId)) {
      return true;
    }

    // Check subscription tier
    if (feature.subscription_tiers && subscriptionTier) {
      if (feature.subscription_tiers.includes(subscriptionTier)) {
        return true;
      }
    }

    // Check percentage rollout
    if (feature.percentage_rollout) {
      // Deterministic hash to ensure same business always gets same result
      const hash = this.hashString(`${featureName}-${businessId}`);
      const value = (parseInt(hash.substring(0, 8), 16) % 100) / 100;
      if (value * 100 < feature.percentage_rollout) {
        return true;
      }
    }

    // Check dependencies
    if (feature.depends_on && feature.depends_on.length > 0) {
      for (const dep of feature.depends_on) {
        const depEnabled = await this.isEnabledForBusiness(dep, businessId, subscriptionTier);
        if (!depEnabled) {
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Get all enabled features for business
   */
  async getEnabledForBusiness(
    businessId: string,
    subscriptionTier?: string
  ): Promise<FeatureFlag[]> {
    const allFeatures = await this.find({ enabled: true });
    const enabled: FeatureFlag[] = [];

    for (const feature of allFeatures) {
      const isEnabled = await this.isEnabledForBusiness(
        feature.name,
        businessId,
        subscriptionTier
      );
      if (isEnabled) {
        enabled.push(feature);
      }
    }

    return enabled;
  }

  /**
   * Enable feature for business
   */
  async enableForBusiness(
    featureName: Feature,
    businessId: string
  ): Promise<FeatureFlag | null> {
    const feature = await this.findOne({ name: featureName });
    
    if (!feature) {
      return null;
    }

    // Add business to list
    const businessIds = feature.business_ids || [];
    if (!businessIds.includes(businessId)) {
      businessIds.push(businessId);
    }

    return this.update(feature.id, {
      business_ids: businessIds,
      global: false,
    });
  }

  /**
   * Disable feature for business
   */
  async disableForBusiness(
    featureName: Feature,
    businessId: string
  ): Promise<FeatureFlag | null> {
    const feature = await this.findOne({ name: featureName });
    
    if (!feature || !feature.business_ids) {
      return null;
    }

    // Remove business from list
    const businessIds = feature.business_ids.filter(id => id !== businessId);

    return this.update(feature.id, {
      business_ids: businessIds,
    });
  }

  /**
   * Increment usage counter
   */
  async incrementUsage(featureName: Feature): Promise<void> {
    const feature = await this.findOne({ name: featureName });
    
    if (!feature) {
      return;
    }

    await this.update(feature.id, {
      current_usage: (feature.current_usage || 0) + 1,
    });
  }

  /**
   * Get feature usage statistics
   */
  async getUsageStats(featureName: Feature): Promise<any> {
    const feature = await this.findOne({ name: featureName });
    
    if (!feature) {
      return null;
    }

    return {
      name: feature.name,
      enabled: feature.enabled,
      current_usage: feature.current_usage || 0,
      max_usage: feature.max_usage,
      usage_percentage: feature.max_usage 
        ? ((feature.current_usage || 0) / feature.max_usage) * 100
        : null,
      business_count: feature.business_ids?.length || 0,
      global: feature.global,
    };
  }

  /**
   * Get features by status
   */
  async getByStatus(enabled: boolean): Promise<FeatureFlag[]> {
    return this.find({ enabled });
  }

  /**
   * Get expiring features
   */
  async getExpiring(days: number = 7): Promise<FeatureFlag[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);

    const query = `
      SELECT * FROM feature_flags
      WHERE end_date <= $1
        AND end_date > NOW()
        AND enabled = true
        AND deleted_at IS NULL
      ORDER BY end_date ASC
    `;

    const result = await db.query(query, [cutoff]);
    return result.rows;
  }

  /**
   * Bulk update features for subscription tier
   */
  async updateForSubscriptionTier(
    tier: string,
    features: Feature[],
    enabled: boolean
  ): Promise<number> {
    let updated = 0;

    for (const featureName of features) {
      const feature = await this.findOne({ name: featureName });
      
      if (!feature) {
        continue;
      }

      const subscriptionTiers = feature.subscription_tiers || [];
      
      if (enabled && !subscriptionTiers.includes(tier)) {
        subscriptionTiers.push(tier);
        await this.update(feature.id, { subscription_tiers: subscriptionTiers });
        updated++;
      } else if (!enabled && subscriptionTiers.includes(tier)) {
        const newTiers = subscriptionTiers.filter(t => t !== tier);
        await this.update(feature.id, { subscription_tiers: newTiers });
        updated++;
      }
    }

    return updated;
  }

  /**
   * Get feature dependencies
   */
  async getDependencies(featureName: Feature): Promise<FeatureFlag[]> {
    const feature = await this.findOne({ name: featureName });
    
    if (!feature || !feature.depends_on) {
      return [];
    }

    const dependencies: FeatureFlag[] = [];
    for (const depName of feature.depends_on) {
      const dep = await this.findOne({ name: depName });
      if (dep) {
        dependencies.push(dep);
      }
    }

    return dependencies;
  }

  /**
   * Validate feature dependencies
   */
  async validateDependencies(featureName: Feature): Promise<{
    valid: boolean;
    missing: Feature[];
  }> {
    const feature = await this.findOne({ name: featureName });
    
    if (!feature || !feature.depends_on) {
      return { valid: true, missing: [] };
    }

    const missing: Feature[] = [];
    
    for (const depName of feature.depends_on) {
      const dep = await this.findOne({ name: depName });
      if (!dep || !dep.enabled) {
        missing.push(depName);
      }
    }

    return {
      valid: missing.length === 0,
      missing,
    };
  }

  /**
   * Get feature rollout progress
   */
  async getRolloutProgress(featureName: Feature): Promise<any> {
    const feature = await this.findOne({ name: featureName });
    
    if (!feature || !feature.percentage_rollout) {
      return null;
    }

    // Get total active businesses
    const totalBusinesses = await db.query(
      `SELECT COUNT(*) as count FROM businesses WHERE deleted_at IS NULL`
    );

    // Get businesses that have this feature enabled
    const enabledBusinesses = feature.business_ids?.length || 0;

    // Calculate theoretical enabled based on percentage
    const theoreticalEnabled = Math.floor(
      (feature.percentage_rollout / 100) * parseInt(totalBusinesses.rows[0].count)
    );

    return {
      feature: feature.name,
      target_percentage: feature.percentage_rollout,
      target_businesses: theoreticalEnabled,
      actual_enabled: enabledBusinesses,
      progress_percentage: theoreticalEnabled > 0 
        ? (enabledBusinesses / theoreticalEnabled) * 100 
        : 0,
    };
  }

  /**
   * Simple hash function for consistent rollout
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }
}

export const featureFlagModel = new FeatureFlagModel();

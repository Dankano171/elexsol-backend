import { BaseModel, BaseEntity } from './BaseModel';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { BUSINESS_SIZE } from '../config/constants/business-rules';
import { v4 as uuidv4 } from 'uuid';

export interface Business extends BaseEntity {
  name: string;
  legal_name: string;
  tin: string; // Tax Identification Number
  cac_number?: string; // Corporate Affairs Commission number
  vat_number?: string;
  email: string;
  phone: string;
  website?: string;
  
  // Address
  address: string;
  city: string;
  state: string;
  country: string;
  postal_code?: string;
  
  // Business details
  sector: string;
  sub_sector?: string;
  turnover_band: 'micro' | 'small' | 'medium' | 'large';
  employee_count: number;
  year_established?: number;
  
  // Regulatory
  firs_status: 'pending' | 'active' | 'suspended' | 'cancelled';
  firs_registered_at?: Date;
  firs_certificate?: string;
  csid?: string; // Communication Session ID
  csid_expires_at?: Date;
  
  // Settings
  invoice_prefix: string;
  next_invoice_number: number;
  default_currency: string;
  fiscal_year_start: string; // MM-DD format
  tax_settings: {
    vat_rate: number;
    vat_filing_frequency: 'monthly' | 'quarterly' | 'annual';
    witholding_tax_rate?: number;
    excise_duty_rates?: Record<string, number>;
  };
  
  // Integrations
  integration_settings: {
    zoho?: Record<string, any>;
    whatsapp?: Record<string, any>;
    quickbooks?: Record<string, any>;
  };
  
  // Subscription
  subscription_tier: 'free' | 'starter' | 'growth' | 'enterprise';
  subscription_status: 'active' | 'past_due' | 'cancelled' | 'trial';
  subscription_expires_at?: Date;
  features: string[];
  
  // Banking
  bank_details?: {
    bank_name: string;
    bank_code: string;
    account_name: string;
    account_number: string;
    account_type: 'savings' | 'current';
  }[];
  
  // Metadata
  settings: Record<string, any>;
  metadata: Record<string, any>;
  created_by?: string;
  updated_by?: string;
}

export interface CreateBusinessDTO {
  name: string;
  legal_name: string;
  tin: string;
  cac_number?: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  country: string;
  postal_code?: string;
  sector: string;
  employee_count: number;
  year_established?: number;
}

export class BusinessModel extends BaseModel<Business> {
  protected tableName = 'businesses';
  protected primaryKey = 'id';

  /**
   * Create a new business
   */
  async createBusiness(data: CreateBusinessDTO, createdBy?: string): Promise<Business> {
    const client = await this.beginTransaction();
    
    try {
      // Check if TIN exists
      const existing = await this.findByTIN(data.tin);
      if (existing) {
        throw new Error('Business with this TIN already exists');
      }

      // Determine turnover band based on default (will be updated later)
      const turnover_band = 'micro';

      // Generate invoice prefix from business name
      const invoice_prefix = this.generateInvoicePrefix(data.name);

      const business = await this.create({
        ...data,
        turnover_band,
        firs_status: 'pending',
        invoice_prefix,
        next_invoice_number: 1,
        default_currency: 'NGN',
        fiscal_year_start: '01-01', // Default to calendar year
        tax_settings: {
          vat_rate: 7.5,
          vat_filing_frequency: 'quarterly',
        },
        integration_settings: {},
        subscription_tier: 'free',
        subscription_status: 'trial',
        features: ['e-invoicing', 'basic-analytics'],
        settings: {},
        metadata: {},
        created_by: createdBy,
        updated_by: createdBy,
      }, client);

      await this.commitTransaction(client);
      
      return business;
    } catch (error) {
      await this.rollbackTransaction(client);
      logger.error('Error in BusinessModel.createBusiness:', error);
      throw error;
    }
  }

  /**
   * Find business by TIN
   */
  async findByTIN(tin: string): Promise<Business | null> {
    return this.findOne({ tin });
  }

  /**
   * Find business by CAC number
   */
  async findByCAC(cacNumber: string): Promise<Business | null> {
    return this.findOne({ cac_number: cacNumber });
  }

  /**
   * Update turnover band based on annual turnover
   */
  async updateTurnoverBand(businessId: string, annualTurnover: number): Promise<Business> {
    let turnover_band: Business['turnover_band'];

    if (annualTurnover <= BUSINESS_SIZE.MICRO.max) {
      turnover_band = 'micro';
    } else if (annualTurnover <= BUSINESS_SIZE.SMALL.max) {
      turnover_band = 'small';
    } else if (annualTurnover <= BUSINESS_SIZE.MEDIUM.max) {
      turnover_band = 'medium';
    } else {
      turnover_band = 'large';
    }

    const business = await this.update(businessId, { turnover_band });
    
    if (!business) {
      throw new Error('Business not found');
    }

    return business;
  }

  /**
   * Update FIRS registration status
   */
  async updateFIRSStatus(
    businessId: string,
    status: Business['firs_status'],
    csid?: string,
    csidExpiresAt?: Date
  ): Promise<Business> {
    const updates: Partial<Business> = {
      firs_status: status,
    };

    if (status === 'active') {
      updates.firs_registered_at = new Date();
    }

    if (csid) {
      updates.csid = csid;
      updates.csid_expires_at = csidExpiresAt;
    }

    const business = await this.update(businessId, updates);
    
    if (!business) {
      throw new Error('Business not found');
    }

    return business;
  }

  /**
   * Update subscription
   */
  async updateSubscription(
    businessId: string,
    tier: Business['subscription_tier'],
    status: Business['subscription_status'],
    expiresAt?: Date
  ): Promise<Business> {
    // Get features for tier
    const features = this.getFeaturesForTier(tier);

    const business = await this.update(businessId, {
      subscription_tier: tier,
      subscription_status: status,
      subscription_expires_at: expiresAt,
      features,
    });

    if (!business) {
      throw new Error('Business not found');
    }

    return business;
  }

  /**
   * Add bank details
   */
  async addBankDetails(
    businessId: string,
    bankDetails: NonNullable<Business['bank_details']>[0]
  ): Promise<Business> {
    const business = await this.findById(businessId);
    
    if (!business) {
      throw new Error('Business not found');
    }

    const currentDetails = business.bank_details || [];
    const updatedDetails = [...currentDetails, bankDetails];

    const updated = await this.update(businessId, {
      bank_details: updatedDetails,
    });

    return updated!;
  }

  /**
   * Update tax settings
   */
  async updateTaxSettings(
    businessId: string,
    settings: Partial<Business['tax_settings']>
  ): Promise<Business> {
    const business = await this.findById(businessId);
    
    if (!business) {
      throw new Error('Business not found');
    }

    const updated = await this.update(businessId, {
      tax_settings: {
        ...business.tax_settings,
        ...settings,
      },
    });

    return updated!;
  }

  /**
   * Get next invoice number and increment
   */
  async getNextInvoiceNumber(businessId: string, client?: any): Promise<string> {
    const executor = client || db;
    
    const result = await executor.query(
      `UPDATE businesses
       SET next_invoice_number = next_invoice_number + 1,
           updated_at = NOW()
       WHERE id = $1
       RETURNING invoice_prefix, next_invoice_number - 1 as number`,
      [businessId]
    );

    if (result.rows.length === 0) {
      throw new Error('Business not found');
    }

    const { invoice_prefix, number } = result.rows[0];
    const year = new Date().getFullYear();
    
    return `${invoice_prefix}-${year}-${number.toString().padStart(5, '0')}`;
  }

  /**
   * Search businesses
   */
  async search(query: string, filters?: {
    status?: Business['firs_status'];
    tier?: Business['subscription_tier'];
    state?: string;
  }): Promise<Business[]> {
    let sql = `
      SELECT * FROM businesses
      WHERE (name ILIKE $1 OR legal_name ILIKE $1 OR tin ILIKE $1 OR email ILIKE $1)
        AND deleted_at IS NULL
    `;

    const params: any[] = [`%${query}%`];
    let paramIndex = 2;

    if (filters?.status) {
      sql += ` AND firs_status = $${paramIndex}`;
      params.push(filters.status);
      paramIndex++;
    }

    if (filters?.tier) {
      sql += ` AND subscription_tier = $${paramIndex}`;
      params.push(filters.tier);
      paramIndex++;
    }

    if (filters?.state) {
      sql += ` AND state = $${paramIndex}`;
      params.push(filters.state);
      paramIndex++;
    }

    sql += ` ORDER BY created_at DESC LIMIT 50`;

    const result = await db.query(sql, params);
    return result.rows;
  }

  /**
   * Get businesses by status
   */
  async getByFIRSStatus(status: Business['firs_status']): Promise<Business[]> {
    return this.find({ firs_status: status });
  }

  /**
   * Get businesses by subscription tier
   */
  async getBySubscriptionTier(tier: Business['subscription_tier']): Promise<Business[]> {
    return this.find({ subscription_tier: tier });
  }

  /**
   * Get expiring CSIDs
   */
  async getExpiringCSIDs(days: number = 30): Promise<Business[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);

    const query = `
      SELECT * FROM businesses
      WHERE csid IS NOT NULL
        AND csid_expires_at <= $1
        AND firs_status = 'active'
        AND deleted_at IS NULL
      ORDER BY csid_expires_at ASC
    `;

    const result = await db.query(query, [cutoff]);
    return result.rows;
  }

  /**
   * Get trial expiring businesses
   */
  async getTrialExpiring(days: number = 7): Promise<Business[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);

    const query = `
      SELECT * FROM businesses
      WHERE subscription_status = 'trial'
        AND subscription_expires_at <= $1
        AND deleted_at IS NULL
      ORDER BY subscription_expires_at ASC
    `;

    const result = await db.query(query, [cutoff]);
    return result.rows;
  }

  /**
   * Get business statistics
   */
  async getStatistics(): Promise<any> {
    const query = `
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN firs_status = 'active' THEN 1 END) as active_firs,
        COUNT(CASE WHEN firs_status = 'pending' THEN 1 END) as pending_firs,
        COUNT(CASE WHEN subscription_status = 'trial' THEN 1 END) as on_trial,
        COUNT(CASE WHEN subscription_status = 'active' THEN 1 END) as active_subscriptions,
        turnover_band,
        subscription_tier,
        state
      FROM businesses
      WHERE deleted_at IS NULL
      GROUP BY turnover_band, subscription_tier, state
    `;

    const result = await db.query(query);
    return result.rows;
  }

  /**
   * Generate invoice prefix from business name
   */
  private generateInvoicePrefix(name: string): string {
    // Take first 3 letters, uppercase, remove special chars
    const prefix = name
      .replace(/[^a-zA-Z0-9]/g, '')
      .substring(0, 3)
      .toUpperCase();
    
    return prefix || 'INV';
  }

  /**
   * Get features for subscription tier
   */
  private getFeaturesForTier(tier: Business['subscription_tier']): string[] {
    const features = {
      free: ['e-invoicing', 'basic-analytics', 'email-support'],
      starter: ['e-invoicing', 'advanced-analytics', 'integrations', 'email-support', 'api-access'],
      growth: ['e-invoicing', 'advanced-analytics', 'integrations', 'priority-support', 'api-access', 'multi-user'],
      enterprise: ['e-invoicing', 'advanced-analytics', 'integrations', 'dedicated-support', 'api-access', 'multi-user', 'white-label', 'custom-integrations'],
    };

    return features[tier] || features.free;
  }
}

export const businessModel = new BusinessModel();

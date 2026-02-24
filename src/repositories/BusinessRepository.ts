import { BaseRepository } from './BaseRepository';
import { Business } from '../models/Business';
import { db } from '../config/database';
import { logger } from '../config/logger';

export class BusinessRepository extends BaseRepository<Business> {
  protected tableName = 'businesses';
  protected primaryKey = 'id';

  /**
   * Find by TIN
   */
  async findByTIN(tin: string): Promise<Business | null> {
    return this.findOne({ tin });
  }

  /**
   * Find by CAC number
   */
  async findByCAC(cacNumber: string): Promise<Business | null> {
    return this.findOne({ cac_number: cacNumber });
  }

  /**
   * Find by email
   */
  async findByEmail(email: string): Promise<Business | null> {
    return this.findOne({ email: email.toLowerCase() });
  }

  /**
   * Search businesses
   */
  async search(
    query: string,
    filters?: {
      status?: Business['firs_status'];
      tier?: Business['subscription_tier'];
      state?: string;
    },
    limit: number = 50
  ): Promise<Business[]> {
    let sql = `
      SELECT * FROM businesses
      WHERE (
        name ILIKE $1
        OR legal_name ILIKE $1
        OR tin ILIKE $1
        OR email ILIKE $1
        OR phone ILIKE $1
      )
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

    sql += ` AND deleted_at IS NULL
             ORDER BY 
               CASE 
                 WHEN name ILIKE $1 THEN 1
                 WHEN legal_name ILIKE $1 THEN 2
                 WHEN tin ILIKE $1 THEN 3
                 ELSE 4
               END,
               created_at DESC
             LIMIT $${paramIndex}`;
    
    params.push(limit);

    return this.executeQuery<Business>(sql, params);
  }

  /**
   * Get businesses by status
   */
  async findByFIRSStatus(
    status: Business['firs_status'],
    limit?: number
  ): Promise<Business[]> {
    return this.find(
      { firs_status: status },
      { orderBy: 'created_at', orderDir: 'ASC', limit }
    );
  }

  /**
   * Get businesses by subscription tier
   */
  async findBySubscriptionTier(
    tier: Business['subscription_tier'],
    limit?: number
  ): Promise<Business[]> {
    return this.find(
      { subscription_tier: tier, subscription_status: 'active' },
      { orderBy: 'created_at', orderDir: 'DESC', limit }
    );
  }

  /**
   * Get expiring CSIDs
   */
  async findExpiringCSIDs(days: number = 30): Promise<Business[]> {
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

    return this.executeQuery<Business>(query, [cutoff]);
  }

  /**
   * Get trial expiring
   */
  async findTrialExpiring(days: number = 7): Promise<Business[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);

    const query = `
      SELECT * FROM businesses
      WHERE subscription_status = 'trial'
        AND subscription_expires_at <= $1
        AND deleted_at IS NULL
      ORDER BY subscription_expires_at ASC
    `;

    return this.executeQuery<Business>(query, [cutoff]);
  }

  /**
   * Get businesses by region
   */
  async findByRegion(
    state?: string,
    city?: string
  ): Promise<Business[]> {
    const conditions: any = {};
    if (state) conditions.state = state;
    if (city) conditions.city = city;
    
    return this.find(conditions, { orderBy: 'name', orderDir: 'ASC' });
  }

  /**
   * Get businesses by turnover band
   */
  async findByTurnoverBand(
    band: Business['turnover_band']
  ): Promise<Business[]> {
    return this.find({ turnover_band: band });
  }

  /**
   * Get next invoice number
   */
  async getNextInvoiceNumber(businessId: string): Promise<string> {
    const result = await db.query(
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
   * Update FIRS status
   */
  async updateFIRSStatus(
    businessId: string,
    status: Business['firs_status'],
    csid?: string,
    csidExpiresAt?: Date
  ): Promise<Business | null> {
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

    return this.update(businessId, updates);
  }

  /**
   * Update subscription
   */
  async updateSubscription(
    businessId: string,
    tier: Business['subscription_tier'],
    status: Business['subscription_status'],
    expiresAt?: Date
  ): Promise<Business | null> {
    // Get features for tier
    const features = this.getFeaturesForTier(tier);

    return this.update(businessId, {
      subscription_tier: tier,
      subscription_status: status,
      subscription_expires_at: expiresAt,
      features,
    });
  }

  /**
   * Add bank details
   */
  async addBankDetails(
    businessId: string,
    bankDetails: NonNullable<Business['bank_details']>[0]
  ): Promise<Business | null> {
    const business = await this.findById(businessId);
    if (!business) return null;

    const currentDetails = business.bank_details || [];
    const updatedDetails = [...currentDetails, bankDetails];

    return this.update(businessId, {
      bank_details: updatedDetails,
    });
  }

  /**
   * Update tax settings
   */
  async updateTaxSettings(
    businessId: string,
    settings: Partial<Business['tax_settings']>
  ): Promise<Business | null> {
    const business = await this.findById(businessId);
    if (!business) return null;

    return this.update(businessId, {
      tax_settings: {
        ...business.tax_settings,
        ...settings,
      },
    });
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
        
        -- Breakdowns
        (SELECT json_object_agg(turnover_band, count)
         FROM (SELECT turnover_band, COUNT(*) as count
               FROM businesses WHERE deleted_at IS NULL GROUP BY turnover_band) t
        ) as by_turnover,
        
        (SELECT json_object_agg(subscription_tier, count)
         FROM (SELECT subscription_tier, COUNT(*) as count
               FROM businesses WHERE deleted_at IS NULL GROUP BY subscription_tier) t
        ) as by_tier,
        
        (SELECT json_object_agg(state, count)
         FROM (SELECT state, COUNT(*) as count
               FROM businesses WHERE deleted_at IS NULL GROUP BY state) t
        ) as by_state,
        
        -- Monthly growth
        (SELECT json_agg(row_to_json(g))
         FROM (
           SELECT 
             DATE_TRUNC('month', created_at) as month,
             COUNT(*) as new_businesses
           FROM businesses
           WHERE created_at >= NOW() - INTERVAL '12 months'
           GROUP BY DATE_TRUNC('month', created_at)
           ORDER BY month DESC
         ) g
        ) as monthly_growth
        
      FROM businesses
      WHERE deleted_at IS NULL
    `;

    const result = await this.executeQuery<any>(query);
    return result[0];
  }

  /**
   * Get revenue by business
   */
  async getRevenueByBusiness(
    fromDate: Date,
    toDate: Date,
    limit: number = 10
  ): Promise<any[]> {
    const query = `
      SELECT 
        b.id,
        b.name,
        b.tin,
        COUNT(i.id) as invoice_count,
        SUM(i.total_amount) as total_revenue,
        AVG(i.total_amount) as avg_invoice_value,
        SUM(i.amount_paid) as total_collected,
        SUM(i.balance_due) as outstanding
      FROM businesses b
      LEFT JOIN invoices i ON i.business_id = b.id
        AND i.created_at BETWEEN $1 AND $2
        AND i.deleted_at IS NULL
      WHERE b.deleted_at IS NULL
      GROUP BY b.id, b.name, b.tin
      ORDER BY total_revenue DESC
      LIMIT $3
    `;

    return this.executeQuery(query, [fromDate, toDate, limit]);
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

export const businessRepository = new BusinessRepository();

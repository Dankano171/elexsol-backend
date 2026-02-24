import { BaseRepository } from './BaseRepository';
import { Transaction } from '../models/Transaction';
import { db } from '../config/database';
import { logger } from '../config/logger';

export class TransactionRepository extends BaseRepository<Transaction> {
  protected tableName = 'transactions';
  protected primaryKey = 'id';

  /**
   * Find by reference
   */
  async findByReference(reference: string): Promise<Transaction | null> {
    return this.findOne({ transaction_reference: reference });
  }

  /**
   * Find by external reference
   */
  async findByExternalReference(externalReference: string): Promise<Transaction | null> {
    return this.findOne({ external_reference: externalReference });
  }

  /**
   * Find by invoice
   */
  async findByInvoice(
    invoiceId: string,
    options?: { status?: Transaction['status'] }
  ): Promise<Transaction[]> {
    const conditions: any = { invoice_id: invoiceId };
    if (options?.status) {
      conditions.status = options.status;
    }
    return this.find(conditions, {
      orderBy: 'transaction_date',
      orderDir: 'DESC',
    });
  }

  /**
   * Find by business
   */
  async findByBusiness(
    businessId: string,
    options?: {
      status?: Transaction['status'];
      fromDate?: Date;
      toDate?: Date;
      paymentMethod?: Transaction['payment_method'];
      limit?: number;
      offset?: number;
    }
  ): Promise<{ transactions: Transaction[]; total: number }> {
    const conditions: any = { business_id: businessId };

    if (options?.status) {
      conditions.status = options.status;
    }

    if (options?.paymentMethod) {
      conditions.payment_method = options.paymentMethod;
    }

    if (options?.fromDate || options?.toDate) {
      conditions.transaction_date = {};
      if (options.fromDate) {
        conditions.transaction_date.$gte = options.fromDate;
      }
      if (options.toDate) {
        conditions.transaction_date.$lte = options.toDate;
      }
    }

    const [transactions, total] = await Promise.all([
      this.find(conditions, {
        orderBy: 'transaction_date',
        orderDir: 'DESC',
        limit: options?.limit,
        offset: options?.offset,
      }),
      this.count(conditions),
    ]);

    return { transactions, total };
  }

  /**
   * Find by payer
   */
  async findByPayer(
    payerName: string,
    payerEmail?: string,
    businessId?: string
  ): Promise<Transaction[]> {
    const conditions: any = {
      payer_name: payerName,
    };

    if (payerEmail) {
      conditions.payer_email = payerEmail;
    }

    if (businessId) {
      conditions.business_id = businessId;
    }

    return this.find(conditions, {
      orderBy: 'transaction_date',
      orderDir: 'DESC',
    });
  }

  /**
   * Find pending transactions
   */
  async findPending(
    businessId: string,
    olderThanMinutes: number = 60
  ): Promise<Transaction[]> {
    const cutoff = new Date();
    cutoff.setMinutes(cutoff.getMinutes() - olderThanMinutes);

    const query = `
      SELECT * FROM transactions
      WHERE business_id = $1
        AND status = 'pending'
        AND transaction_date <= $2
        AND deleted_at IS NULL
      ORDER BY transaction_date ASC
    `;

    return this.executeQuery<Transaction>(query, [businessId, cutoff]);
  }

  /**
   * Find by date range
   */
  async findByDateRange(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<Transaction[]> {
    return this.find(
      {
        business_id: businessId,
        transaction_date: { $gte: fromDate, $lte: toDate },
      },
      { orderBy: 'transaction_date', orderDir: 'ASC' }
    );
  }

  /**
   * Get daily summary
   */
  async getDailySummary(
    businessId: string,
    date: Date
  ): Promise<any> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const query = `
      SELECT
        payment_method,
        COUNT(*) as transaction_count,
        SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as completed_amount,
        SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) as pending_amount,
        SUM(CASE WHEN status = 'failed' THEN amount ELSE 0 END) as failed_amount,
        AVG(CASE WHEN status = 'completed' THEN amount ELSE NULL END) as average_amount,
        MIN(CASE WHEN status = 'completed' THEN amount ELSE NULL END) as min_amount,
        MAX(CASE WHEN status = 'completed' THEN amount ELSE NULL END) as max_amount
      FROM transactions
      WHERE business_id = $1
        AND transaction_date BETWEEN $2 AND $3
        AND deleted_at IS NULL
      GROUP BY payment_method
    `;

    return this.executeQuery(query, [businessId, startOfDay, endOfDay]);
  }

  /**
   * Get monthly summary
   */
  async getMonthlySummary(
    businessId: string,
    year: number,
    month: number
  ): Promise<any> {
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    const query = `
      SELECT
        DATE(transaction_date) as date,
        COUNT(*) as transaction_count,
        SUM(amount) as total_amount,
        SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as completed_amount,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_count,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count
      FROM transactions
      WHERE business_id = $1
        AND transaction_date BETWEEN $2 AND $3
        AND deleted_at IS NULL
      GROUP BY DATE(transaction_date)
      ORDER BY date ASC
    `;

    return this.executeQuery(query, [businessId, startOfMonth, endOfMonth]);
  }

  /**
   * Get reconciliation report
   */
  async getReconciliationReport(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<any> {
    const query = `
      SELECT
        DATE(transaction_date) as date,
        payment_method,
        COUNT(*) as expected_count,
        SUM(amount) as expected_amount,
        COUNT(CASE WHEN reconciled THEN 1 END) as reconciled_count,
        SUM(CASE WHEN reconciled THEN amount ELSE 0 END) as reconciled_amount,
        COUNT(CASE WHEN NOT reconciled AND status = 'completed' THEN 1 END) as unreconciled_count,
        SUM(CASE WHEN NOT reconciled AND status = 'completed' THEN amount ELSE 0 END) as unreconciled_amount
      FROM transactions
      WHERE business_id = $1
        AND transaction_date BETWEEN $2 AND $3
        AND status = 'completed'
        AND deleted_at IS NULL
      GROUP BY DATE(transaction_date), payment_method
      ORDER BY date DESC, payment_method
    `;

    return this.executeQuery(query, [businessId, fromDate, toDate]);
  }

  /**
   * Reconcile transactions
   */
  async reconcile(
    transactionIds: string[],
    reconciledBy: string
  ): Promise<number> {
    const query = `
      UPDATE transactions
      SET reconciled = true,
          reconciled_at = NOW(),
          reconciled_by = $2,
          updated_at = NOW()
      WHERE id = ANY($1::uuid[])
        AND reconciled = false
        AND status = 'completed'
      RETURNING id
    `;

    const result = await db.query(query, [transactionIds, reconciledBy]);
    return result.rowCount || 0;
  }

  /**
   * Get unreconciled
   */
  async getUnreconciled(
    businessId: string,
    days?: number
  ): Promise<Transaction[]> {
    let query = `
      SELECT * FROM transactions
      WHERE business_id = $1
        AND reconciled = false
        AND status = 'completed'
    `;

    const params: any[] = [businessId];

    if (days) {
      query += ` AND transaction_date >= NOW() - INTERVAL '${days} days'`;
    }

    query += ` ORDER BY transaction_date ASC`;

    return this.executeQuery<Transaction>(query, params);
  }

  /**
   * Get payment method stats
   */
  async getPaymentMethodStats(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<any[]> {
    const query = `
      SELECT
        payment_method,
        COUNT(*) as usage_count,
        SUM(amount) as total_amount,
        AVG(amount) as average_amount,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful_count,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count,
        (COUNT(CASE WHEN status = 'failed' THEN 1 END)::float / COUNT(*)::float * 100) as failure_rate
      FROM transactions
      WHERE business_id = $1
        AND transaction_date BETWEEN $2 AND $3
        AND deleted_at IS NULL
      GROUP BY payment_method
      ORDER BY usage_count DESC
    `;

    return this.executeQuery(query, [businessId, fromDate, toDate]);
  }

  /**
   * Get customer payment behavior
   */
  async getCustomerBehavior(
    businessId: string,
    customerIdentifier: string,
    limit: number = 10
  ): Promise<any> {
    const query = `
      SELECT
        payer_name,
        payer_email,
        COUNT(*) as total_transactions,
        SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as total_spent,
        AVG(CASE WHEN status = 'completed' THEN amount ELSE NULL END) as average_transaction,
        MIN(transaction_date) as first_transaction,
        MAX(transaction_date) as last_transaction,
        MODE() WITHIN GROUP (ORDER BY payment_method) as preferred_method,
        COUNT(DISTINCT DATE(transaction_date)) as active_days
      FROM transactions
      WHERE business_id = $1
        AND (payer_email = $2 OR payer_name = $2)
        AND status = 'completed'
        AND deleted_at IS NULL
      GROUP BY payer_name, payer_email
    `;

    const result = await this.executeQuery(query, [businessId, customerIdentifier]);
    return result[0];
  }

  /**
   * Generate transaction reference
   */
  async generateReference(): Promise<string> {
    const prefix = 'TXN';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    const reference = `${prefix}${timestamp}${random}`;

    // Check if exists
    const existing = await this.findByReference(reference);
    if (existing) {
      return this.generateReference(); // Recursive retry
    }

    return reference;
  }

  /**
   * Get transaction timeline
   */
  async getTimeline(
    transactionId: string
  ): Promise<any[]> {
    const query = `
      SELECT
        status,
        created_at as timestamp,
        CASE
          WHEN status = 'pending' THEN 'Transaction initiated'
          WHEN status = 'completed' THEN 'Transaction completed'
          WHEN status = 'failed' THEN 'Transaction failed: ' || COALESCE(failure_reason, 'Unknown error')
          WHEN status = 'refunded' THEN 'Transaction refunded'
          WHEN status = 'cancelled' THEN 'Transaction cancelled'
        END as description
      FROM transactions
      WHERE id = $1
      
      UNION ALL
      
      SELECT
        'reconciled' as status,
        reconciled_at as timestamp,
        'Transaction reconciled by ' || reconciled_by as description
      FROM transactions
      WHERE id = $1 AND reconciled = true AND reconciled_at IS NOT NULL
      
      ORDER BY timestamp ASC
    `;

    return this.executeQuery(query, [transactionId]);
  }

  /**
   * Bulk update status
   */
  async bulkUpdateStatus(
    ids: string[],
    status: Transaction['status'],
    failureReason?: string
  ): Promise<number> {
    const updates: Partial<Transaction> = { status };
    
    if (status === 'failed' && failureReason) {
      updates.failure_reason = failureReason;
    }

    return this.bulkUpdate(ids, updates);
  }
}

export const transactionRepository = new TransactionRepository();

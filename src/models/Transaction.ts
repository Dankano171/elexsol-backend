import { BaseModel, BaseEntity } from './BaseModel';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { invoiceModel } from './Invoice';

export interface Transaction extends BaseEntity {
  business_id: string;
  invoice_id?: string;
  transaction_reference: string;
  external_reference?: string;
  
  // Payment details
  amount: number;
  currency: string;
  payment_method: 'cash' | 'transfer' | 'cheque' | 'card' | 'pos' | 'direct_debit' | 'other';
  payment_provider?: string;
  
  // Status
  status: 'pending' | 'completed' | 'failed' | 'refunded' | 'cancelled';
  failure_reason?: string;
  
  // Timing
  transaction_date: Date;
  settled_date?: Date;
  
  // Party details
  payer_name: string;
  payer_email?: string;
  payer_phone?: string;
  payer_account?: string;
  
  // Reconciliation
  reconciled: boolean;
  reconciled_at?: Date;
  reconciled_by?: string;
  
  // Metadata
  metadata: Record<string, any>;
  created_by?: string;
  updated_by?: string;
}

export interface CreateTransactionDTO {
  business_id: string;
  invoice_id?: string;
  amount: number;
  currency?: string;
  payment_method: Transaction['payment_method'];
  payment_provider?: string;
  transaction_date?: Date;
  payer_name: string;
  payer_email?: string;
  payer_phone?: string;
  payer_account?: string;
  external_reference?: string;
  metadata?: Record<string, any>;
}

export class TransactionModel extends BaseModel<Transaction> {
  protected tableName = 'transactions';
  protected primaryKey = 'id';

  /**
   * Create a new transaction
   */
  async createTransaction(data: CreateTransactionDTO, createdBy?: string): Promise<Transaction> {
    const client = await this.beginTransaction();
    
    try {
      // Generate transaction reference
      const transaction_reference = await this.generateReference();

      const transaction = await this.create({
        business_id: data.business_id,
        invoice_id: data.invoice_id,
        transaction_reference,
        external_reference: data.external_reference,
        amount: data.amount,
        currency: data.currency || 'NGN',
        payment_method: data.payment_method,
        payment_provider: data.payment_provider,
        status: 'pending',
        transaction_date: data.transaction_date || new Date(),
        payer_name: data.payer_name,
        payer_email: data.payer_email,
        payer_phone: data.payer_phone,
        payer_account: data.payer_account,
        reconciled: false,
        metadata: data.metadata || {},
        created_by: createdBy,
        updated_by: createdBy,
      }, client);

      await this.commitTransaction(client);
      
      return transaction;
    } catch (error) {
      await this.rollbackTransaction(client);
      logger.error('Error in TransactionModel.createTransaction:', error);
      throw error;
    }
  }

  /**
   * Complete a transaction
   */
  async completeTransaction(
    id: string,
    settledDate?: Date,
    metadata?: Record<string, any>
  ): Promise<Transaction> {
    const client = await this.beginTransaction();
    
    try {
      const transaction = await this.findById(id);
      
      if (!transaction) {
        throw new Error('Transaction not found');
      }

      if (transaction.status !== 'pending') {
        throw new Error(`Transaction cannot be completed (status: ${transaction.status})`);
      }

      // Update transaction
      const updated = await this.update(id, {
        status: 'completed',
        settled_date: settledDate || new Date(),
        metadata: {
          ...transaction.metadata,
          ...metadata,
          completed_at: new Date(),
        },
      }, client);

      // Update invoice if linked
      if (transaction.invoice_id) {
        await invoiceModel.updatePaymentStatus(
          transaction.invoice_id,
          transaction.amount,
          settledDate || new Date()
        );
      }

      await this.commitTransaction(client);
      
      return updated!;
    } catch (error) {
      await this.rollbackTransaction(client);
      logger.error('Error in TransactionModel.completeTransaction:', error);
      throw error;
    }
  }

  /**
   * Fail a transaction
   */
  async failTransaction(id: string, reason: string, metadata?: Record<string, any>): Promise<Transaction> {
    const transaction = await this.findById(id);
    
    if (!transaction) {
      throw new Error('Transaction not found');
    }

    const updated = await this.update(id, {
      status: 'failed',
      failure_reason: reason,
      metadata: {
        ...transaction.metadata,
        ...metadata,
        failed_at: new Date(),
      },
    });

    return updated!;
  }

  /**
   * Refund a transaction
   */
  async refundTransaction(
    id: string,
    reason: string,
    refundedBy?: string
  ): Promise<Transaction> {
    const client = await this.beginTransaction();
    
    try {
      const transaction = await this.findById(id);
      
      if (!transaction) {
        throw new Error('Transaction not found');
      }

      if (transaction.status !== 'completed') {
        throw new Error(`Only completed transactions can be refunded (status: ${transaction.status})`);
      }

      // Update transaction
      const updated = await this.update(id, {
        status: 'refunded',
        metadata: {
          ...transaction.metadata,
          refund_reason: reason,
          refunded_at: new Date(),
          refunded_by: refundedBy,
        },
      }, client);

      // Update invoice if linked (reverse the payment)
      if (transaction.invoice_id) {
        await invoiceModel.updatePaymentStatus(
          transaction.invoice_id,
          -transaction.amount,
          new Date()
        );
      }

      await this.commitTransaction(client);
      
      return updated!;
    } catch (error) {
      await this.rollbackTransaction(client);
      logger.error('Error in TransactionModel.refundTransaction:', error);
      throw error;
    }
  }

  /**
   * Get transactions by business
   */
  async getByBusiness(
    businessId: string,
    options?: {
      status?: Transaction['status'];
      fromDate?: Date;
      toDate?: Date;
      invoiceId?: string;
      paymentMethod?: Transaction['payment_method'];
      limit?: number;
      offset?: number;
    }
  ): Promise<{ transactions: Transaction[]; total: number }> {
    let sql = 'SELECT * FROM transactions WHERE business_id = $1 AND deleted_at IS NULL';
    const countSql = 'SELECT COUNT(*) FROM transactions WHERE business_id = $1 AND deleted_at IS NULL';
    const conditions: string[] = [];
    const params: any[] = [businessId];
    let paramIndex = 2;

    if (options?.status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(options.status);
      paramIndex++;
    }

    if (options?.fromDate) {
      conditions.push(`transaction_date >= $${paramIndex}`);
      params.push(options.fromDate);
      paramIndex++;
    }

    if (options?.toDate) {
      conditions.push(`transaction_date <= $${paramIndex}`);
      params.push(options.toDate);
      paramIndex++;
    }

    if (options?.invoiceId) {
      conditions.push(`invoice_id = $${paramIndex}`);
      params.push(options.invoiceId);
      paramIndex++;
    }

    if (options?.paymentMethod) {
      conditions.push(`payment_method = $${paramIndex}`);
      params.push(options.paymentMethod);
      paramIndex++;
    }

    if (conditions.length > 0) {
      const whereClause = ' AND ' + conditions.join(' AND ');
      sql += whereClause;
    }

    sql += ` ORDER BY transaction_date DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    
    const limit = options?.limit || 20;
    const offset = options?.offset || 0;
    params.push(limit, offset);

    const [transactions, countResult] = await Promise.all([
      db.query(sql, params),
      db.query(countSql, [businessId]),
    ]);

    return {
      transactions: transactions.rows,
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * Get transactions by invoice
   */
  async getByInvoice(invoiceId: string): Promise<Transaction[]> {
    return this.find({ invoice_id: invoiceId }, {
      orderBy: 'transaction_date',
      orderDir: 'DESC',
    });
  }

  /**
   * Get by reference
   */
  async getByReference(reference: string): Promise<Transaction | null> {
    return this.findOne({ transaction_reference: reference });
  }

  /**
   * Get by external reference
   */
  async getByExternalReference(externalReference: string): Promise<Transaction | null> {
    return this.findOne({ external_reference: externalReference });
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
          updated_at = NOW(),
          version = version + 1
      WHERE id = ANY($1::uuid[])
        AND reconciled = false
      RETURNING id
    `;

    const result = await db.query(query, [transactionIds, reconciledBy]);
    return result.rowCount || 0;
  }

  /**
   * Get unreconciled transactions
   */
  async getUnreconciled(businessId: string, days?: number): Promise<Transaction[]> {
    let query = `
      SELECT * FROM transactions
      WHERE business_id = $1
        AND reconciled = false
        AND status = 'completed'
    `;

    if (days) {
      query += ` AND transaction_date >= NOW() - INTERVAL '${days} days'`;
    }

    query += ` ORDER BY transaction_date DESC`;

    const result = await db.query(query, [businessId]);
    return result.rows;
  }

  /**
   * Get transaction summary
   */
  async getSummary(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<any> {
    const query = `
      SELECT
        COUNT(*) as total_transactions,
        SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as completed_amount,
        SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) as pending_amount,
        SUM(CASE WHEN status = 'failed' THEN amount ELSE 0 END) as failed_amount,
        SUM(CASE WHEN status = 'refunded' THEN amount ELSE 0 END) as refunded_amount,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_count,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count,
        COUNT(CASE WHEN status = 'refunded' THEN 1 END) as refunded_count,
        payment_method,
        DATE(transaction_date) as date
      FROM transactions
      WHERE business_id = $1
        AND transaction_date BETWEEN $2 AND $3
        AND deleted_at IS NULL
      GROUP BY payment_method, DATE(transaction_date)
      ORDER BY date DESC
    `;

    const result = await db.query(query, [businessId, fromDate, toDate]);
    return result.rows;
  }

  /**
   * Generate unique transaction reference
   */
  private async generateReference(): Promise<string> {
    const prefix = 'TXN';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    const reference = `${prefix}${timestamp}${random}`;

    // Check if exists
    const existing = await this.getByReference(reference);
    if (existing) {
      return this.generateReference(); // Recursive retry
    }

    return reference;
  }

  /**
   * Get daily settlement totals
   */
  async getDailySettlements(
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
        SUM(amount) as total_amount,
        AVG(amount) as average_amount
      FROM transactions
      WHERE business_id = $1
        AND settled_date BETWEEN $2 AND $3
        AND status = 'completed'
        AND deleted_at IS NULL
      GROUP BY payment_method
    `;

    const result = await db.query(query, [businessId, startOfDay, endOfDay]);
    return result.rows;
  }
}

export const transactionModel = new TransactionModel();

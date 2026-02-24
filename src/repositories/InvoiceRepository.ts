import { BaseRepository } from './BaseRepository';
import { Invoice } from '../models/Invoice';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { INVOICE_STATUS, PAYMENT_STATUS } from '../config/constants/business-rules';

export class InvoiceRepository extends BaseRepository<Invoice> {
  protected tableName = 'invoices';
  protected primaryKey = 'id';

  /**
   * Find by invoice number
   */
  async findByNumber(
    invoiceNumber: string,
    businessId: string
  ): Promise<Invoice | null> {
    return this.findOne({
      invoice_number: invoiceNumber,
      business_id: businessId,
    });
  }

  /**
   * Find by IRN
   */
  async findByIRN(irn: string): Promise<Invoice | null> {
    return this.findOne({ firs_irn: irn });
  }

  /**
   * Find by customer
   */
  async findByCustomer(
    customerTin: string,
    businessId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<Invoice[]> {
    return this.find(
      {
        customer_tin: customerTin,
        business_id: businessId,
      },
      {
        orderBy: 'issue_date',
        orderDir: 'DESC',
        ...options,
      }
    );
  }

  /**
   * Find by status
   */
  async findByStatus(
    businessId: string,
    status: Invoice['status'],
    options?: { limit?: number; offset?: number }
  ): Promise<Invoice[]> {
    return this.find(
      {
        business_id: businessId,
        status,
      },
      {
        orderBy: 'issue_date',
        orderDir: 'DESC',
        ...options,
      }
    );
  }

  /**
   * Find overdue invoices
   */
  async findOverdue(
    businessId: string,
    asOfDate: Date = new Date()
  ): Promise<Invoice[]> {
    const query = `
      SELECT * FROM invoices
      WHERE business_id = $1
        AND due_date < $2
        AND payment_status IN ('unpaid', 'partial')
        AND deleted_at IS NULL
      ORDER BY due_date ASC
    `;

    return this.executeQuery<Invoice>(query, [businessId, asOfDate]);
  }

  /**
   * Find invoices due soon
   */
  async findDueSoon(
    businessId: string,
    days: number = 7
  ): Promise<Invoice[]> {
    const now = new Date();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);

    const query = `
      SELECT * FROM invoices
      WHERE business_id = $1
        AND due_date BETWEEN $2 AND $3
        AND payment_status IN ('unpaid', 'partial')
        AND deleted_at IS NULL
      ORDER BY due_date ASC
    `;

    return this.executeQuery<Invoice>(query, [businessId, now, cutoff]);
  }

  /**
   * Find by date range
   */
  async findByDateRange(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<Invoice[]> {
    return this.find(
      {
        business_id: businessId,
        issue_date: { $gte: fromDate, $lte: toDate },
      },
      { orderBy: 'issue_date', orderDir: 'DESC' }
    );
  }

  /**
   * Search invoices
   */
  async search(
    businessId: string,
    query: string,
    limit: number = 50
  ): Promise<Invoice[]> {
    const sql = `
      SELECT * FROM invoices
      WHERE business_id = $1
        AND (
          invoice_number ILIKE $2
          OR customer_name ILIKE $2
          OR customer_tin ILIKE $2
          OR customer_email ILIKE $2
          OR notes ILIKE $2
          OR firs_irn ILIKE $2
        )
        AND deleted_at IS NULL
      ORDER BY 
        CASE 
          WHEN invoice_number ILIKE $2 THEN 1
          WHEN customer_name ILIKE $2 THEN 2
          WHEN customer_tin ILIKE $2 THEN 3
          ELSE 4
        END,
        issue_date DESC
      LIMIT $3
    `;

    return this.executeQuery<Invoice>(sql, [businessId, `%${query}%`, limit]);
  }

  /**
   * Get invoice statistics
   */
  async getStatistics(
    businessId: string,
    fromDate?: Date,
    toDate?: Date
  ): Promise<any> {
    let sql = `
      SELECT
        COUNT(*) as total_invoices,
        COUNT(CASE WHEN payment_status = 'paid' THEN 1 END) as paid_invoices,
        COUNT(CASE WHEN payment_status = 'overdue' THEN 1 END) as overdue_invoices,
        COUNT(CASE WHEN payment_status = 'unpaid' THEN 1 END) as unpaid_invoices,
        COUNT(CASE WHEN firs_status = 'approved' THEN 1 END) as approved_invoices,
        COUNT(CASE WHEN firs_status = 'rejected' THEN 1 END) as rejected_invoices,
        COALESCE(SUM(total_amount), 0) as total_amount,
        COALESCE(SUM(amount_paid), 0) as total_paid,
        COALESCE(SUM(balance_due), 0) as total_outstanding,
        AVG(CASE WHEN paid_at IS NOT NULL 
            THEN EXTRACT(EPOCH FROM (paid_at - issue_date))/86400 
            ELSE NULL END) as avg_days_to_payment,
        MAX(total_amount) as largest_invoice,
        MIN(total_amount) as smallest_invoice
      FROM invoices
      WHERE business_id = $1
        AND deleted_at IS NULL
    `;

    const params: any[] = [businessId];

    if (fromDate && toDate) {
      sql += ` AND issue_date BETWEEN $2 AND $3`;
      params.push(fromDate, toDate);
    }

    const result = await this.executeQuery<any>(sql, params);
    return result[0];
  }

  /**
   * Get monthly totals
   */
  async getMonthlyTotals(
    businessId: string,
    months: number = 12
  ): Promise<any[]> {
    const query = `
      SELECT
        DATE_TRUNC('month', issue_date) as month,
        COUNT(*) as invoice_count,
        SUM(total_amount) as total_amount,
        SUM(amount_paid) as total_paid,
        AVG(total_amount) as average_amount,
        COUNT(CASE WHEN payment_status = 'paid' THEN 1 END) as paid_count,
        COUNT(CASE WHEN payment_status = 'overdue' THEN 1 END) as overdue_count
      FROM invoices
      WHERE business_id = $1
        AND issue_date >= NOW() - INTERVAL '${months} months'
        AND deleted_at IS NULL
      GROUP BY DATE_TRUNC('month', issue_date)
      ORDER BY month DESC
    `;

    return this.executeQuery(query, [businessId]);
  }

  /**
   * Get customer summary
   */
  async getCustomerSummary(
    businessId: string,
    limit: number = 10
  ): Promise<any[]> {
    const query = `
      SELECT
        customer_tin,
        customer_name,
        COUNT(*) as invoice_count,
        SUM(total_amount) as total_billed,
        SUM(amount_paid) as total_paid,
        SUM(balance_due) as outstanding,
        AVG(EXTRACT(DAY FROM (paid_at - issue_date))) as avg_days_to_pay,
        MAX(issue_date) as last_invoice_date
      FROM invoices
      WHERE business_id = $1
        AND deleted_at IS NULL
      GROUP BY customer_tin, customer_name
      ORDER BY total_billed DESC
      LIMIT $2
    `;

    return this.executeQuery(query, [businessId, limit]);
  }

  /**
   * Get aging report
   */
  async getAgingReport(businessId: string): Promise<any> {
    const query = `
      SELECT
        SUM(CASE WHEN due_date >= NOW() THEN balance_due ELSE 0 END) as current,
        SUM(CASE WHEN due_date BETWEEN NOW() - INTERVAL '30 days' AND NOW() THEN balance_due ELSE 0 END) as days_1_30,
        SUM(CASE WHEN due_date BETWEEN NOW() - INTERVAL '60 days' AND NOW() - INTERVAL '31 days' THEN balance_due ELSE 0 END) as days_31_60,
        SUM(CASE WHEN due_date BETWEEN NOW() - INTERVAL '90 days' AND NOW() - INTERVAL '61 days' THEN balance_due ELSE 0 END) as days_61_90,
        SUM(CASE WHEN due_date < NOW() - INTERVAL '90 days' THEN balance_due ELSE 0 END) as days_90_plus,
        COUNT(CASE WHEN due_date < NOW() THEN 1 END) as overdue_count
      FROM invoices
      WHERE business_id = $1
        AND payment_status IN ('unpaid', 'partial')
        AND deleted_at IS NULL
    `;

    const result = await this.executeQuery<any>(query, [businessId]);
    return result[0];
  }

  /**
   * Update payment status
   */
  async updatePaymentStatus(
    invoiceId: string,
    amountPaid: number,
    paymentDate?: Date
  ): Promise<Invoice | null> {
    const invoice = await this.findById(invoiceId);
    if (!invoice) return null;

    const newAmountPaid = (invoice.amount_paid || 0) + amountPaid;
    const balanceDue = invoice.total_amount - newAmountPaid;
    
    let paymentStatus: PaymentStatus;
    if (balanceDue <= 0) {
      paymentStatus = PAYMENT_STATUS.PAID;
    } else if (newAmountPaid > 0) {
      paymentStatus = PAYMENT_STATUS.PARTIAL;
    } else {
      paymentStatus = PAYMENT_STATUS.UNPAID;
    }

    const updates: Partial<Invoice> = {
      amount_paid: newAmountPaid,
      balance_due: balanceDue,
      payment_status: paymentStatus,
    };

    if (paymentStatus === PAYMENT_STATUS.PAID && paymentDate) {
      updates.paid_at = paymentDate;
    }

    return this.update(invoiceId, updates);
  }

  /**
   * Mark overdue
   */
  async markOverdue(): Promise<number> {
    const query = `
      UPDATE invoices
      SET payment_status = 'overdue',
          updated_at = NOW()
      WHERE due_date < NOW()
        AND payment_status IN ('unpaid', 'partial')
        AND deleted_at IS NULL
      RETURNING id
    `;

    const result = await db.query(query);
    return result.rowCount || 0;
  }

  /**
   * Submit to FIRS
   */
  async submitToFIRS(
    invoiceId: string,
    firsData: {
      irn: string;
      qrCode: string;
      signature: string;
      response: Record<string, any>;
    }
  ): Promise<Invoice | null> {
    return this.update(invoiceId, {
      firs_irn: firsData.irn,
      firs_qr_code: firsData.qrCode,
      firs_signature: firsData.signature,
      firs_status: 'submitted',
      firs_response: firsData.response,
      submitted_at: new Date(),
      status: INVOICE_STATUS.SUBMITTED,
    });
  }

  /**
   * Mark FIRS approved
   */
  async markFIRSApproved(
    invoiceId: string,
    response?: Record<string, any>
  ): Promise<Invoice | null> {
    return this.update(invoiceId, {
      firs_status: 'approved',
      firs_response: response,
      approved_at: new Date(),
      status: INVOICE_STATUS.APPROVED,
    });
  }

  /**
   * Mark FIRS rejected
   */
  async markFIRSRejected(
    invoiceId: string,
    errors: Record<string, any>
  ): Promise<Invoice | null> {
    return this.update(invoiceId, {
      firs_status: 'rejected',
      firs_errors: errors,
      status: INVOICE_STATUS.REJECTED,
    });
  }

  /**
   * Cancel invoice
   */
  async cancel(invoiceId: string, reason?: string): Promise<Invoice | null> {
    const invoice = await this.findById(invoiceId);
    if (!invoice) return null;

    if (invoice.firs_status === 'approved') {
      // Need to notify FIRS of cancellation
      // This would trigger a credit note
      throw new Error('Approved invoices must be cancelled via credit note');
    }

    return this.update(invoiceId, {
      status: INVOICE_STATUS.CANCELLED,
      metadata: {
        ...invoice.metadata,
        cancellation_reason: reason,
        cancelled_at: new Date(),
      },
    });
  }

  /**
   * Check for duplicate
   */
  async isDuplicate(
    businessId: string,
    invoiceNumber: string
  ): Promise<boolean> {
    return this.exists({
      business_id: businessId,
      invoice_number: invoiceNumber,
    });
  }

  /**
   * Get line items
   */
  async getLineItems(invoiceId: string): Promise<any[]> {
    const query = `
      SELECT * FROM invoice_line_items
      WHERE invoice_id = $1
      ORDER BY line_number ASC
    `;

    return this.executeQuery(query, [invoiceId]);
  }

  /**
   * Get invoice with line items
   */
  async getWithLineItems(invoiceId: string): Promise<Invoice | null> {
    const invoice = await this.findById(invoiceId);
    if (!invoice) return null;

    const lineItems = await this.getLineItems(invoiceId);
    (invoice as any).line_items = lineItems;

    return invoice;
  }

  /**
   * Export invoices for reporting
   */
  async exportForReporting(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<any[]> {
    const query = `
      SELECT 
        i.invoice_number,
        i.issue_date,
        i.due_date,
        i.customer_name,
        i.customer_tin,
        i.subtotal,
        i.vat_amount,
        i.total_amount,
        i.amount_paid,
        i.balance_due,
        i.payment_status,
        i.firs_status,
        i.firs_irn,
        i.created_at,
        i.paid_at,
        json_agg(
          json_build_object(
            'description', l.description,
            'quantity', l.quantity,
            'unit_price', l.unit_price,
            'total', l.total
          )
        ) as line_items
      FROM invoices i
      LEFT JOIN invoice_line_items l ON l.invoice_id = i.id
      WHERE i.business_id = $1
        AND i.issue_date BETWEEN $2 AND $3
        AND i.deleted_at IS NULL
      GROUP BY i.id
      ORDER BY i.issue_date DESC
    `;

    return this.executeQuery(query, [businessId, fromDate, toDate]);
  }
}

export const invoiceRepository = new InvoiceRepository();

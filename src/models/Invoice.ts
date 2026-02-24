import { BaseModel, BaseEntity } from './BaseModel';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { INVOICE_STATUS, PAYMENT_STATUS, InvoiceStatus, PaymentStatus } from '../config/constants/business-rules';
import { businessModel } from './Business';

export interface Invoice extends BaseEntity {
  business_id: string;
  invoice_number: string;
  external_id?: string;
  
  // Parties
  issuer_tin: string;
  issuer_name: string;
  customer_tin: string;
  customer_name: string;
  customer_email?: string;
  customer_phone?: string;
  customer_address?: string;
  
  // Financial
  subtotal: number;
  vat_amount: number;
  excise_amount: number;
  discount_amount: number;
  total_amount: number;
  amount_paid: number;
  balance_due: number;
  currency: string;
  
  // Dates
  issue_date: Date;
  due_date: Date;
  supply_date?: Date;
  paid_at?: Date;
  
  // Status
  status: InvoiceStatus;
  payment_status: PaymentStatus;
  
  // FIRS Data
  firs_irn?: string; // Invoice Reference Number
  firs_qr_code?: string;
  firs_signature?: string;
  firs_status: 'pending' | 'submitted' | 'approved' | 'rejected' | 'cancelled';
  firs_response?: Record<string, any>;
  firs_errors?: Record<string, any>;
  submitted_at?: Date;
  approved_at?: Date;
  
  // PDF/Storage
  pdf_url?: string;
  xml_data?: string;
  
  // Notes
  notes?: string;
  terms?: string;
  
  // Metadata
  metadata: Record<string, any>;
  created_by?: string;
  updated_by?: string;
}

export interface CreateInvoiceDTO {
  business_id: string;
  customer_tin: string;
  customer_name: string;
  customer_email?: string;
  customer_phone?: string;
  customer_address?: string;
  issue_date: Date;
  due_date: Date;
  supply_date?: Date;
  line_items: Array<{
    description: string;
    quantity: number;
    unit_price: number;
    discount?: number;
    vat_rate?: number;
    excise_rate?: number;
  }>;
  notes?: string;
  terms?: string;
  metadata?: Record<string, any>;
}

export interface UpdateInvoiceDTO {
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  customer_address?: string;
  due_date?: Date;
  notes?: string;
  terms?: string;
  metadata?: Record<string, any>;
}

export class InvoiceModel extends BaseModel<Invoice> {
  protected tableName = 'invoices';
  protected primaryKey = 'id';

  /**
   * Create a new invoice
   */
  async createInvoice(data: CreateInvoiceDTO, createdBy?: string): Promise<Invoice> {
    const client = await this.beginTransaction();
    
    try {
      // Get next invoice number
      const invoiceNumber = await businessModel.getNextInvoiceNumber(data.business_id, client);

      // Calculate totals
      let subtotal = 0;
      let vatAmount = 0;
      let exciseAmount = 0;
      let discountAmount = 0;

      for (const item of data.line_items) {
        const itemSubtotal = item.quantity * item.unit_price;
        const itemDiscount = (item.discount || 0) * itemSubtotal / 100;
        const itemAfterDiscount = itemSubtotal - itemDiscount;
        
        subtotal += itemSubtotal;
        discountAmount += itemDiscount;
        
        // VAT calculation (default 7.5%)
        const vatRate = item.vat_rate || 7.5;
        vatAmount += itemAfterDiscount * vatRate / 100;
        
        // Excise duty if applicable
        if (item.excise_rate) {
          exciseAmount += itemAfterDiscount * item.excise_rate / 100;
        }
      }

      const totalAmount = subtotal - discountAmount + vatAmount + exciseAmount;

      // Get business TIN
      const business = await businessModel.findById(data.business_id);
      if (!business) {
        throw new Error('Business not found');
      }

      const invoice = await this.create({
        business_id: data.business_id,
        invoice_number: invoiceNumber,
        
        issuer_tin: business.tin,
        issuer_name: business.legal_name,
        
        customer_tin: data.customer_tin,
        customer_name: data.customer_name,
        customer_email: data.customer_email,
        customer_phone: data.customer_phone,
        customer_address: data.customer_address,
        
        subtotal,
        vat_amount: vatAmount,
        excise_amount: exciseAmount,
        discount_amount: discountAmount,
        total_amount: totalAmount,
        amount_paid: 0,
        balance_due: totalAmount,
        currency: business.default_currency || 'NGN',
        
        issue_date: data.issue_date,
        due_date: data.due_date,
        supply_date: data.supply_date,
        
        status: INVOICE_STATUS.DRAFT,
        payment_status: PAYMENT_STATUS.UNPAID,
        
        firs_status: 'pending',
        
        notes: data.notes,
        terms: data.terms,
        
        metadata: data.metadata || {},
        created_by: createdBy,
        updated_by: createdBy,
      }, client);

      // Create line items
      for (let i = 0; i < data.line_items.length; i++) {
        const item = data.line_items[i];
        await client.query(
          `INSERT INTO invoice_line_items (
            id, invoice_id, line_number, description, quantity,
            unit_price, discount_rate, vat_rate, excise_rate,
            subtotal, vat_amount, excise_amount, total,
            created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
            NOW(), NOW()
          )`,
          [
            invoice.id,
            i + 1,
            item.description,
            item.quantity,
            item.unit_price,
            item.discount || 0,
            item.vat_rate || 7.5,
            item.excise_rate || 0,
            item.quantity * item.unit_price,
            (item.quantity * item.unit_price * (1 - (item.discount || 0)/100)) * (item.vat_rate || 7.5) / 100,
            (item.quantity * item.unit_price * (1 - (item.discount || 0)/100)) * (item.excise_rate || 0) / 100,
            item.quantity * item.unit_price * (1 - (item.discount || 0)/100) * (1 + (item.vat_rate || 7.5)/100 + (item.excise_rate || 0)/100)
          ]
        );
      }

      await this.commitTransaction(client);
      
      // Fetch complete invoice with line items
      const completeInvoice = await this.getWithLineItems(invoice.id);
      
      return completeInvoice!;
    } catch (error) {
      await this.rollbackTransaction(client);
      logger.error('Error in InvoiceModel.createInvoice:', error);
      throw error;
    }
  }

  /**
   * Get invoice with line items
   */
  async getWithLineItems(id: string): Promise<Invoice | null> {
    const invoice = await this.findById(id);
    
    if (!invoice) {
      return null;
    }

    const lineItems = await db.query(
      `SELECT * FROM invoice_line_items
       WHERE invoice_id = $1
       ORDER BY line_number ASC`,
      [id]
    );

    (invoice as any).line_items = lineItems.rows;
    
    return invoice;
  }

  /**
   * Get invoices by business
   */
  async getByBusiness(
    businessId: string,
    options?: {
      status?: InvoiceStatus;
      payment_status?: PaymentStatus;
      fromDate?: Date;
      toDate?: Date;
      customerTin?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ invoices: Invoice[]; total: number }> {
    let sql = 'SELECT * FROM invoices WHERE business_id = $1 AND deleted_at IS NULL';
    const countSql = 'SELECT COUNT(*) FROM invoices WHERE business_id = $1 AND deleted_at IS NULL';
    const conditions: string[] = [];
    const params: any[] = [businessId];
    let paramIndex = 2;

    if (options?.status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(options.status);
      paramIndex++;
    }

    if (options?.payment_status) {
      conditions.push(`payment_status = $${paramIndex}`);
      params.push(options.payment_status);
      paramIndex++;
    }

    if (options?.fromDate) {
      conditions.push(`issue_date >= $${paramIndex}`);
      params.push(options.fromDate);
      paramIndex++;
    }

    if (options?.toDate) {
      conditions.push(`issue_date <= $${paramIndex}`);
      params.push(options.toDate);
      paramIndex++;
    }

    if (options?.customerTin) {
      conditions.push(`customer_tin = $${paramIndex}`);
      params.push(options.customerTin);
      paramIndex++;
    }

    if (conditions.length > 0) {
      const whereClause = ' AND ' + conditions.join(' AND ');
      sql += whereClause;
    }

    sql += ` ORDER BY issue_date DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    
    const limit = options?.limit || 20;
    const offset = options?.offset || 0;
    params.push(limit, offset);

    const [invoices, countResult] = await Promise.all([
      db.query(sql, params),
      db.query(countSql, [businessId]),
    ]);

    return {
      invoices: invoices.rows,
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * Get invoices by customer
   */
  async getByCustomer(
    customerTin: string,
    businessId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<Invoice[]> {
    return this.find({
      customer_tin: customerTin,
      business_id: businessId,
    }, {
      limit: options?.limit,
      offset: options?.offset,
      orderBy: 'issue_date',
      orderDir: 'DESC',
    });
  }

  /**
   * Update payment status
   */
  async updatePaymentStatus(
    id: string,
    amountPaid: number,
    paymentDate?: Date
  ): Promise<Invoice> {
    const invoice = await this.findById(id);
    
    if (!invoice) {
      throw new Error('Invoice not found');
    }

    const newAmountPaid = invoice.amount_paid + amountPaid;
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

    const updated = await this.update(id, updates);
    
    if (!updated) {
      throw new Error('Failed to update invoice');
    }

    return updated;
  }

  /**
   * Mark as overdue
   */
  async markOverdue(): Promise<void> {
    const query = `
      UPDATE invoices
      SET payment_status = 'overdue',
          updated_at = NOW(),
          version = version + 1
      WHERE due_date < NOW()
        AND payment_status IN ('unpaid', 'partial')
        AND deleted_at IS NULL
      RETURNING id
    `;

    const result = await db.query(query);
    
    if (result.rowCount && result.rowCount > 0) {
      logger.info(`Marked ${result.rowCount} invoices as overdue`);
    }
  }

  /**
   * Submit to FIRS
   */
  async submitToFIRS(id: string, firsData: {
    irn: string;
    qrCode: string;
    signature: string;
    response: Record<string, any>;
  }): Promise<Invoice> {
    const updated = await this.update(id, {
      firs_irn: firsData.irn,
      firs_qr_code: firsData.qrCode,
      firs_signature: firsData.signature,
      firs_status: 'submitted',
      firs_response: firsData.response,
      submitted_at: new Date(),
      status: INVOICE_STATUS.SUBMITTED,
    });

    if (!updated) {
      throw new Error('Invoice not found');
    }

    return updated;
  }

  /**
   * Mark as approved by FIRS
   */
  async markFIRSApproved(id: string, response?: Record<string, any>): Promise<Invoice> {
    const updated = await this.update(id, {
      firs_status: 'approved',
      firs_response: response,
      approved_at: new Date(),
      status: INVOICE_STATUS.APPROVED,
    });

    if (!updated) {
      throw new Error('Invoice not found');
    }

    return updated;
  }

  /**
   * Mark as rejected by FIRS
   */
  async markFIRSRejected(id: string, errors: Record<string, any>): Promise<Invoice> {
    const updated = await this.update(id, {
      firs_status: 'rejected',
      firs_errors: errors,
      status: INVOICE_STATUS.REJECTED,
    });

    if (!updated) {
      throw new Error('Invoice not found');
    }

    return updated;
  }

  /**
   * Cancel invoice
   */
  async cancel(id: string, reason?: string): Promise<Invoice> {
    const invoice = await this.findById(id);
    
    if (!invoice) {
      throw new Error('Invoice not found');
    }

    if (invoice.firs_status === 'approved') {
      // Need to notify FIRS of cancellation
      // This would trigger a credit note
      throw new Error('Approved invoices must be cancelled via credit note');
    }

    const updated = await this.update(id, {
      status: INVOICE_STATUS.CANCELLED,
      metadata: {
        ...invoice.metadata,
        cancellation_reason: reason,
        cancelled_at: new Date(),
      },
    });

    return updated!;
  }

  /**
   * Get invoice statistics
   */
  async getStatistics(businessId: string, fromDate?: Date, toDate?: Date): Promise<any> {
    const dateFilter = fromDate && toDate ? 'AND issue_date BETWEEN $2 AND $3' : '';
    const params: any[] = [businessId];
    
    if (fromDate && toDate) {
      params.push(fromDate, toDate);
    }

    const query = `
      SELECT
        COUNT(*) as total_invoices,
        SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) as paid_invoices,
        SUM(CASE WHEN payment_status = 'overdue' THEN 1 ELSE 0 END) as overdue_invoices,
        SUM(CASE WHEN payment_status = 'unpaid' THEN 1 ELSE 0 END) as unpaid_invoices,
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
        ${dateFilter}
    `;

    const result = await db.query(query, params);
    return result.rows[0];
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
        SUM(CASE WHEN due_date < NOW() - INTERVAL '90 days' THEN balance_due ELSE 0 END) as days_90_plus
      FROM invoices
      WHERE business_id = $1
        AND payment_status IN ('unpaid', 'partial')
        AND deleted_at IS NULL
    `;

    const result = await db.query(query, [businessId]);
    return result.rows[0];
  }

  /**
   * Search invoices
   */
  async search(businessId: string, query: string): Promise<Invoice[]> {
    const searchQuery = `
      SELECT * FROM invoices
      WHERE business_id = $1
        AND (
          invoice_number ILIKE $2
          OR customer_name ILIKE $2
          OR customer_tin ILIKE $2
          OR customer_email ILIKE $2
          OR notes ILIKE $2
        )
        AND deleted_at IS NULL
      ORDER BY issue_date DESC
      LIMIT 50
    `;

    const result = await db.query(searchQuery, [businessId, `%${query}%`]);
    return result.rows;
  }

  /**
   * Duplicate check
   */
  async isDuplicate(businessId: string, invoiceNumber: string): Promise<boolean> {
    const existing = await this.findOne({
      business_id: businessId,
      invoice_number: invoiceNumber,
    });

    return !!existing;
  }

  /**
   * Get upcoming due invoices
   */
  async getUpcomingDue(businessId: string, days: number = 7): Promise<Invoice[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);

    return this.find({
      business_id: businessId,
      payment_status: ['unpaid', 'partial'],
      due_date: { $lte: cutoff } as any,
    }, {
      orderBy: 'due_date',
      orderDir: 'ASC',
    });
  }
}

export const invoiceModel = new InvoiceModel();

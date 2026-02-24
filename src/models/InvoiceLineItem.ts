import { BaseModel, BaseEntity } from './BaseModel';

export interface InvoiceLineItem extends BaseEntity {
  invoice_id: string;
  line_number: number;
  description: string;
  quantity: number;
  unit_price: number;
  discount_rate: number;
  vat_rate: number;
  excise_rate: number;
  subtotal: number;
  vat_amount: number;
  excise_amount: number;
  total: number;
  metadata?: Record<string, any>;
}

export class InvoiceLineItemModel extends BaseModel<InvoiceLineItem> {
  protected tableName = 'invoice_line_items';
  protected primaryKey = 'id';

  /**
   * Get line items for invoice
   */
  async getByInvoice(invoiceId: string): Promise<InvoiceLineItem[]> {
    return this.find({ invoice_id: invoiceId }, {
      orderBy: 'line_number',
      orderDir: 'ASC',
    });
  }

  /**
   * Bulk create line items
   */
  async bulkCreate(items: Array<Omit<InvoiceLineItem, keyof BaseEntity>>): Promise<InvoiceLineItem[]> {
    const results: InvoiceLineItem[] = [];
    
    for (const item of items) {
      const result = await this.create(item);
      results.push(result);
    }
    
    return results;
  }

  /**
   * Delete all line items for invoice
   */
  async deleteByInvoice(invoiceId: string): Promise<boolean> {
    const query = `
      DELETE FROM invoice_line_items
      WHERE invoice_id = $1
    `;

    await this.rawQuery(query, [invoiceId]);
    return true;
  }

  /**
   * Get line items statistics
   */
  async getStatistics(invoiceId: string): Promise<{
    total_items: number;
    average_unit_price: number;
    most_expensive: number;
    least_expensive: number;
  }> {
    const query = `
      SELECT
        COUNT(*) as total_items,
        AVG(unit_price) as average_unit_price,
        MAX(unit_price) as most_expensive,
        MIN(unit_price) as least_expensive
      FROM invoice_line_items
      WHERE invoice_id = $1
    `;

    const result = await this.rawQuery(query, [invoiceId]);
    return result[0];
  }
}

export const invoiceLineItemModel = new InvoiceLineItemModel();

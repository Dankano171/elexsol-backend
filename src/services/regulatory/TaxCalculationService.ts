import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { businessRepository } from '../../repositories/BusinessRepository';
import { logger } from '../../config/logger';
import { VAT_CONFIG } from '../../config/constants/business-rules';

export interface TaxBreakdown {
  subtotal: number;
  vat: {
    rate: number;
    amount: number;
    exemptAmount: number;
    zeroRatedAmount: number;
    details: Array<{
      description: string;
      taxableAmount: number;
      vatRate: number;
      vatAmount: number;
      exemptionReason?: string;
    }>;
  };
  excise: {
    total: number;
    details: Array<{
      description: string;
      rate: number;
      amount: number;
    }>;
  };
  withholding: {
    total: number;
    details: Array<{
      description: string;
      rate: number;
      amount: number;
    }>;
  };
  grandTotal: number;
}

export interface TaxReport {
  period: {
    from: Date;
    to: Date;
  };
  summary: {
    totalSales: number;
    totalVATCollected: number;
    totalVATPayable: number;
    totalInputVAT: number;
    netVATPayable: number;
    filingDueDate: Date;
  };
  sales: Array<{
    invoiceNumber: string;
    date: Date;
    customer: string;
    amount: number;
    vatRate: number;
    vatAmount: number;
    status: string;
  }>;
  purchases: Array<{
    invoiceNumber: string;
    date: Date;
    supplier: string;
    amount: number;
    vatAmount: number;
    reclaimable: boolean;
  }>;
  reconciliations: {
    expectedVAT: number;
    actualVAT: number;
    variance: number;
    adjustments: Array<{
      reason: string;
      amount: number;
    }>;
  };
}

export class TaxCalculationService {
  private readonly vatRate = VAT_CONFIG.RATE;
  private readonly exemptCategories = VAT_CONFIG.EXEMPT_CATEGORIES;
  private readonly zeroRatedCategories = VAT_CONFIG.ZERO_RATED_CATEGORIES;

  /**
   * Calculate tax for invoice
   */
  async calculateInvoiceTax(
    businessId: string,
    invoiceData: any
  ): Promise<TaxBreakdown> {
    try {
      const business = await businessRepository.findById(businessId);
      
      if (!business) {
        throw new Error('Business not found');
      }

      const breakdown: TaxBreakdown = {
        subtotal: 0,
        vat: {
          rate: business.tax_settings?.vat_rate || this.vatRate,
          amount: 0,
          exemptAmount: 0,
          zeroRatedAmount: 0,
          details: []
        },
        excise: {
          total: 0,
          details: []
        },
        withholding: {
          total: 0,
          details: []
        },
        grandTotal: 0
      };

      // Calculate per line item
      for (const item of invoiceData.line_items) {
        const itemSubtotal = item.quantity * item.unit_price;
        breakdown.subtotal += itemSubtotal;

        // Apply discount if any
        const discountAmount = (item.discount_rate || 0) * itemSubtotal / 100;
        const taxableAmount = itemSubtotal - discountAmount;

        // Calculate VAT
        const vatDetail = this.calculateVAT(
          item,
          taxableAmount,
          business.tax_settings
        );
        
        breakdown.vat.details.push(vatDetail);
        breakdown.vat.amount += vatDetail.vatAmount;
        
        if (vatDetail.exemptionReason) {
          breakdown.vat.exemptAmount += taxableAmount;
        } else if (vatDetail.vatRate === 0) {
          breakdown.vat.zeroRatedAmount += taxableAmount;
        }

        // Calculate excise duty
        if (item.excise_rate && item.excise_rate > 0) {
          const exciseAmount = taxableAmount * item.excise_rate / 100;
          breakdown.excise.details.push({
            description: item.description,
            rate: item.excise_rate,
            amount: exciseAmount
          });
          breakdown.excise.total += exciseAmount;
        }

        // Calculate withholding tax
        if (item.withholding_rate && item.withholding_rate > 0) {
          const withholdingAmount = taxableAmount * item.withholding_rate / 100;
          breakdown.withholding.details.push({
            description: item.description,
            rate: item.withholding_rate,
            amount: withholdingAmount
          });
          breakdown.withholding.total += withholdingAmount;
        }
      }

      // Calculate grand total
      breakdown.grandTotal = breakdown.subtotal + 
                             breakdown.vat.amount + 
                             breakdown.excise.total -
                             breakdown.withholding.total;

      return breakdown;
    } catch (error) {
      logger.error('Error calculating invoice tax:', error);
      throw error;
    }
  }

  /**
   * Calculate VAT for a single line item
   */
  private calculateVAT(
    item: any,
    taxableAmount: number,
    taxSettings: any
  ): TaxBreakdown['vat']['details'][0] {
    const result: TaxBreakdown['vat']['details'][0] = {
      description: item.description,
      taxableAmount,
      vatRate: item.vat_rate || taxSettings?.vat_rate || this.vatRate,
      vatAmount: 0
    };

    // Check for exemption
    if (item.vat_exempt) {
      result.vatRate = 0;
      result.vatAmount = 0;
      result.exemptionReason = item.exemption_reason || 'VAT exempt';
      return result;
    }

    // Check for zero rating
    if (this.isZeroRated(item)) {
      result.vatRate = 0;
      result.vatAmount = 0;
      return result;
    }

    // Calculate VAT amount
    result.vatAmount = taxableAmount * result.vatRate / 100;

    return result;
  }

  /**
   * Check if item is zero-rated
   */
  private isZeroRated(item: any): boolean {
    // Check if item category is in zero-rated list
    if (item.category && this.zeroRatedCategories.includes(item.category)) {
      return true;
    }

    // Check for export
    if (item.is_export) {
      return true;
    }

    return false;
  }

  /**
   * Generate tax report for period
   */
  async generateTaxReport(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<TaxReport> {
    try {
      const [invoices, business] = await Promise.all([
        invoiceRepository.findByDateRange(businessId, fromDate, toDate),
        businessRepository.findById(businessId)
      ]);

      if (!business) {
        throw new Error('Business not found');
      }

      const report: TaxReport = {
        period: { from: fromDate, to: toDate },
        summary: {
          totalSales: 0,
          totalVATCollected: 0,
          totalVATPayable: 0,
          totalInputVAT: 0,
          netVATPayable: 0,
          filingDueDate: this.calculateFilingDueDate(toDate)
        },
        sales: [],
        purchases: [],
        reconciliations: {
          expectedVAT: 0,
          actualVAT: 0,
          variance: 0,
          adjustments: []
        }
      };

      // Process sales invoices
      for (const invoice of invoices) {
        if (invoice.type === 'sales') {
          report.summary.totalSales += invoice.total_amount;
          report.summary.totalVATCollected += invoice.vat_amount;

          report.sales.push({
            invoiceNumber: invoice.invoice_number,
            date: invoice.issue_date,
            customer: invoice.customer_name,
            amount: invoice.total_amount,
            vatRate: invoice.vat_rate || this.vatRate,
            vatAmount: invoice.vat_amount,
            status: invoice.payment_status
          });
        } else if (invoice.type === 'purchase') {
          // Handle purchase invoices (input VAT)
          const reclaimable = this.isInputVATReclaimable(invoice);
          if (reclaimable) {
            report.summary.totalInputVAT += invoice.vat_amount;
          }

          report.purchases.push({
            invoiceNumber: invoice.invoice_number,
            date: invoice.issue_date,
            supplier: invoice.supplier_name,
            amount: invoice.total_amount,
            vatAmount: invoice.vat_amount,
            reclaimable
          });
        }
      }

      // Calculate net VAT payable
      report.summary.netVATPayable = report.summary.totalVATCollected - 
                                     report.summary.totalInputVAT;

      // Calculate expected VAT (simplified - in production, use tax rules)
      report.reconciliations.expectedVAT = report.summary.totalSales * this.vatRate / 100;
      report.reconciliations.actualVAT = report.summary.totalVATCollected;
      report.reconciliations.variance = report.reconciliations.actualVAT - 
                                        report.reconciliations.expectedVAT;

      return report;
    } catch (error) {
      logger.error('Error generating tax report:', error);
      throw error;
    }
  }

  /**
   * Check if input VAT is reclaimable
   */
  private isInputVATReclaimable(invoice: any): boolean {
    // Check if supplier is registered for VAT
    if (!invoice.supplier_tin || !invoice.supplier_vat_registered) {
      return false;
    }

    // Check if expense is business-related
    if (!invoice.is_business_expense) {
      return false;
    }

    // Check if invoice is valid (has IRN)
    if (!invoice.firs_irn) {
      return false;
    }

    return true;
  }

  /**
   * Calculate filing due date (21st of following month)
   */
  private calculateFilingDueDate(periodEnd: Date): Date {
    const dueDate = new Date(periodEnd);
    dueDate.setMonth(dueDate.getMonth() + 1);
    dueDate.setDate(21);
    return dueDate;
  }

  /**
   * Calculate VAT liability for period
   */
  async calculateVATLiability(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<{
    outputVAT: number;
    inputVAT: number;
    netLiability: number;
    dueDate: Date;
  }> {
    const report = await this.generateTaxReport(businessId, fromDate, toDate);

    return {
      outputVAT: report.summary.totalVATCollected,
      inputVAT: report.summary.totalInputVAT,
      netLiability: report.summary.netVATPayable,
      dueDate: report.summary.filingDueDate
    };
  }

  /**
   * Validate VAT calculation for invoice
   */
  validateVATCalculation(invoice: any): {
    valid: boolean;
    errors: string[];
    expectedVAT: number;
    actualVAT: number;
  } {
    const errors: string[] = [];
    let expectedVAT = 0;

    // Check each line item
    for (const item of invoice.line_items) {
      const itemSubtotal = item.quantity * item.unit_price;
      const discountAmount = (item.discount_rate || 0) * itemSubtotal / 100;
      const taxableAmount = itemSubtotal - discountAmount;

      // Calculate expected VAT
      const vatRate = item.vat_rate || this.vatRate;
      const itemVAT = taxableAmount * vatRate / 100;
      expectedVAT += itemVAT;

      // Compare with provided VAT
      if (Math.abs(item.vat_amount - itemVAT) > 0.01) {
        errors.push(`Line item ${item.line_number}: VAT amount ${item.vat_amount} does not match expected ${itemVAT}`);
      }
    }

    // Check total VAT
    const totalVAT = invoice.vat_amount || 0;
    if (Math.abs(totalVAT - expectedVAT) > 0.01) {
      errors.push(`Total VAT ${totalVAT} does not match sum of line items ${expectedVAT}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      expectedVAT,
      actualVAT: totalVAT
    };
  }

  /**
   * Calculate withholding tax
   */
  calculateWithholdingTax(
    amount: number,
    supplierType: 'individual' | 'corporate',
    transactionType: string
  ): {
    rate: number;
    amount: number;
    exempt: boolean;
  } {
    // WHT rates based on Nigerian tax law
    const rates: Record<string, number> = {
      'individual_contract': 5,
      'corporate_contract': 10,
      'rent': 10,
      'dividend': 10,
      'interest': 10,
      'director_fee': 10
    };

    const rate = rates[`${supplierType}_${transactionType}`] || 
                 rates[transactionType] || 
                 0;

    return {
      rate,
      amount: amount * rate / 100,
      exempt: rate === 0
    };
  }

  /**
   * Get tax rates for business
   */
  async getTaxRates(businessId: string): Promise<{
    vat: number;
    excise: Record<string, number>;
    withholding: Record<string, number>;
  }> {
    const business = await businessRepository.findById(businessId);
    
    return {
      vat: business?.tax_settings?.vat_rate || this.vatRate,
      excise: business?.tax_settings?.excise_duty_rates || {},
      withholding: {
        contract: 5,
        rent: 10,
        dividend: 10,
        interest: 10
      }
    };
  }

  /**
   * Generate VAT filing return
   */
  async generateVATReturn(
    businessId: string,
    period: { year: number; month: number }
  ): Promise<Buffer> {
    const fromDate = new Date(period.year, period.month - 1, 1);
    const toDate = new Date(period.year, period.month, 0);
    
    const report = await this.generateTaxReport(businessId, fromDate, toDate);
    
    // Format for CSV output
    const lines = ['VAT Return'];
    lines.push(`Period: ${period.year}-${period.month.toString().padStart(2, '0')}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    
    lines.push('Summary');
    lines.push(`Total Sales,₦${report.summary.totalSales.toLocaleString()}`);
    lines.push(`VAT Collected,₦${report.summary.totalVATCollected.toLocaleString()}`);
    lines.push(`Input VAT,₦${report.summary.totalInputVAT.toLocaleString()}`);
    lines.push(`Net VAT Payable,₦${report.summary.netVATPayable.toLocaleString()}`);
    lines.push(`Due Date,${report.summary.filingDueDate.toLocaleDateString()}`);
    lines.push('');
    
    lines.push('Sales Details');
    lines.push('Invoice Number,Date,Customer,Amount,VAT Rate,VAT Amount');
    
    report.sales.forEach(s => {
      lines.push(
        `${s.invoiceNumber},${s.date.toLocaleDateString()},${s.customer},` +
        `₦${s.amount.toLocaleString()},${s.vatRate}%,₦${s.vatAmount.toLocaleString()}`
      );
    });

    return Buffer.from(lines.join('\n'));
  }
}

export const taxCalculationService = new TaxCalculationService();

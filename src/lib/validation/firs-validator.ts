// src/lib/validation/firs-validator.ts
import { z } from 'zod';

// FIRS mandatory 55 fields schema
export const FIRSInvoiceSchema = z.object({
  // Header Information (10 fields)
  invoiceNumber: z.string().min(1).max(50),
  invoiceType: z.enum(['INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE']),
  invoiceCurrency: z.string().length(3).default('NGN'),
  invoiceIssueDate: z.string().datetime(),
  invoiceDueDate: z.string().datetime(),
  invoiceSupplyDate: z.string().datetime().optional(),
  
  // Seller Information (12 fields)
  sellerTIN: z.string().length(10), // 10-digit Tax Identification Number
  sellerName: z.string().min(1).max(255),
  sellerAddress: z.string().min(1).max(500),
  sellerCity: z.string().min(1).max(100),
  sellerState: z.string().min(1).max(50),
  sellerCountry: z.string().length(2).default('NG'),
  sellerPostalCode: z.string().max(20).optional(),
  sellerEmail: z.string().email().optional(),
  sellerPhone: z.string().max(20).optional(),
  sellerCACNumber: z.string().max(20).optional(),
  sellerVATNumber: z.string().max(20).optional(),
  
  // Buyer Information (10 fields)
  buyerTIN: z.string().length(10),
  buyerName: z.string().min(1).max(255),
  buyerAddress: z.string().min(1).max(500),
  buyerCity: z.string().min(1).max(100),
  buyerState: z.string().min(1).max(50),
  buyerCountry: z.string().length(2).default('NG'),
  buyerPostalCode: z.string().max(20).optional(),
  buyerEmail: z.string().email().optional(),
  buyerPhone: z.string().max(20).optional(),
  buyerType: z.enum(['BUSINESS', 'INDIVIDUAL', 'GOVERNMENT']),
  
  // Line Items (15 fields - per item)
  lineItems: z.array(z.object({
    lineNumber: z.number().int().positive(),
    itemCode: z.string().max(50).optional(),
    itemDescription: z.string().min(1).max(500),
    quantity: z.number().positive(),
    unitOfMeasure: z.string().max(20),
    unitPrice: z.number().positive(),
    discountAmount: z.number().min(0).default(0),
    discountRate: z.number().min(0).max(100).optional(),
    lineSubtotal: z.number().positive(),
    vatRate: z.number().default(7.5),
    vatAmount: z.number().min(0),
    vatExemptionReason: z.string().optional(),
    exciseRate: z.number().optional(),
    exciseAmount: z.number().optional(),
    lineTotal: z.number().positive()
  })).min(1),
  
  // Totals (8 fields)
  totalExclusiveVAT: z.number().positive(),
  totalVATAmount: z.number().min(0),
  totalExciseAmount: z.number().min(0).default(0),
  totalDiscountAmount: z.number().min(0).default(0),
  totalPayableAmount: z.number().positive(),
  amountInWords: z.string().min(1),
  
  // Payment & Delivery (5 fields)
  paymentTerms: z.string().optional(),
  paymentMethod: z.enum(['CASH', 'TRANSFER', 'CHEQUE', 'CARD', 'POS', 'OTHER']),
  paymentReference: z.string().optional(),
  deliveryMethod: z.string().optional(),
  deliveryDate: z.string().datetime().optional(),
  
  // Regulatory (5 fields)
  qrCode: z.string().optional(),
  digitalSignature: z.string().optional(),
  signatureDate: z.string().datetime().optional(),
  irn: z.string().optional(), // Invoice Reference Number
  csid: z.string().optional() // Communication Session ID
});

export type FIRSInvoice = z.infer<typeof FIRSInvoiceSchema>;

export class FIRSValidator {
  static validate(invoice: any): { valid: boolean; errors: string[] } {
    try {
      FIRSInvoiceSchema.parse(invoice);
      return { valid: true, errors: [] };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          valid: false,
          errors: error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
        };
      }
      return {
        valid: false,
        errors: ['Unknown validation error']
      };
    }
  }

  static validateField(field: string, value: any): boolean {
    const fieldSchema = FIRSInvoiceSchema.shape[field as keyof typeof FIRSInvoiceSchema.shape];
    if (!fieldSchema) return false;
    
    try {
      fieldSchema.parse(value);
      return true;
    } catch {
      return false;
    }
  }

  static getMandatoryFields(): string[] {
    const mandatory: string[] = [];
    
    const traverse = (schema: any, path: string[] = []) => {
      if (schema._def?.typeName === 'ZodObject') {
        Object.entries(schema.shape).forEach(([key, value]: [string, any]) => {
          traverse(value, [...path, key]);
        });
      } else if (path.length > 0) {
        mandatory.push(path.join('.'));
      }
    };
    
    traverse(FIRSInvoiceSchema);
    return mandatory;
  }
}

import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { businessRepository } from '../../repositories/BusinessRepository';
import { logger } from '../../config/logger';
import { FIRS_MANDATORY_FIELDS } from '../../config/constants/firs-schema';
import { validate as validateTIN } from 'tin-validator'; // You'd need to implement this

export interface ValidationResult {
  valid: boolean;
  score: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  recommendations: string[];
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
  code: string;
  value?: any;
  expected?: any;
}

export interface DocumentMetadata {
  documentId: string;
  documentType: string;
  createdAt: Date;
  createdBy: string;
  version: number;
  previousVersion?: string;
  signatures: Array<{
    type: string;
    signer: string;
    timestamp: Date;
    valid: boolean;
  }>;
}

export class DocumentValidationService {
  private readonly tinRegex = /^\d{10}$/;
  private readonly emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  private readonly phoneRegex = /^\+?[\d\s\-()]{10,}$/;

  /**
   * Validate invoice document
   */
  async validateInvoice(
    invoiceId: string,
    options: {
      strict?: boolean;
      checkFIRS?: boolean;
    } = {}
  ): Promise<ValidationResult> {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    try {
      const invoice = await invoiceRepository.getWithLineItems(invoiceId);
      
      if (!invoice) {
        throw new Error('Invoice not found');
      }

      // Check required fields from FIRS schema
      for (const field of FIRS_MANDATORY_FIELDS) {
        if (field.required) {
          const value = this.getFieldValue(invoice, field.path);
          
          if (!value && value !== 0) {
            errors.push({
              field: field.path,
              message: `Missing required field: ${field.name}`,
              severity: 'error',
              code: 'VAL-001'
            });
          } else if (field.pattern && !field.pattern.test(String(value))) {
            errors.push({
              field: field.path,
              message: `Invalid format for ${field.name}`,
              severity: 'error',
              code: 'VAL-002',
              value,
              expected: field.pattern
            });
          }
        }
      }

      // Validate TINs
      if (invoice.issuer_tin) {
        const tinValid = this.validateTIN(invoice.issuer_tin);
        if (!tinValid) {
          errors.push({
            field: 'issuer_tin',
            message: 'Invalid issuer TIN format',
            severity: 'error',
            code: 'VAL-003',
            value: invoice.issuer_tin
          });
        }
      }

      if (invoice.customer_tin) {
        const tinValid = this.validateTIN(invoice.customer_tin);
        if (!tinValid) {
          errors.push({
            field: 'customer_tin',
            message: 'Invalid customer TIN format',
            severity: 'error',
            code: 'VAL-003',
            value: invoice.customer_tin
          });
        }
      }

      // Validate dates
      if (invoice.issue_date && invoice.due_date) {
        if (new Date(invoice.due_date) < new Date(invoice.issue_date)) {
          errors.push({
            field: 'due_date',
            message: 'Due date cannot be before issue date',
            severity: 'error',
            code: 'VAL-004',
            value: invoice.due_date,
            expected: invoice.issue_date
          });
        }
      }

      // Validate line items
      if (!invoice.line_items || invoice.line_items.length === 0) {
        errors.push({
          field: 'line_items',
          message: 'Invoice must have at least one line item',
          severity: 'error',
          code: 'VAL-005'
        });
      } else {
        let lineNumber = 1;
        for (const item of invoice.line_items) {
          // Check line number sequence
          if (item.line_number !== lineNumber) {
            warnings.push({
              field: `line_items[${lineNumber-1}].line_number`,
              message: 'Line numbers should be sequential',
              severity: 'warning',
              code: 'VAL-101',
              value: item.line_number,
              expected: lineNumber
            });
          }

          // Validate quantity
          if (item.quantity <= 0) {
            errors.push({
              field: `line_items[${lineNumber-1}].quantity`,
              message: 'Quantity must be positive',
              severity: 'error',
              code: 'VAL-006',
              value: item.quantity
            });
          }

          // Validate price
          if (item.unit_price <= 0) {
            errors.push({
              field: `line_items[${lineNumber-1}].unit_price`,
              message: 'Unit price must be positive',
              severity: 'error',
              code: 'VAL-007',
              value: item.unit_price
            });
          }

          lineNumber++;
        }
      }

      // Validate totals
      const calculatedTotal = this.calculateInvoiceTotal(invoice);
      if (Math.abs(invoice.total_amount - calculatedTotal) > 0.01) {
        errors.push({
          field: 'total_amount',
          message: 'Total amount does not match calculated total',
          severity: 'error',
          code: 'VAL-008',
          value: invoice.total_amount,
          expected: calculatedTotal
        });
      }

      // Generate recommendations
      const recommendations = this.generateRecommendations(errors, warnings);

      return {
        valid: errors.length === 0,
        score: this.calculateScore(errors, warnings),
        errors,
        warnings,
        recommendations
      };
    } catch (error) {
      logger.error('Error validating invoice:', error);
      throw error;
    }
  }

  /**
   * Validate business registration
   */
  async validateBusiness(businessId: string): Promise<ValidationResult> {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    try {
      const business = await businessRepository.findById(businessId);
      
      if (!business) {
        throw new Error('Business not found');
      }

      // Validate TIN
      if (!business.tin || !this.validateTIN(business.tin)) {
        errors.push({
          field: 'tin',
          message: 'Invalid Tax Identification Number',
          severity: 'error',
          code: 'VAL-003',
          value: business.tin
        });
      }

      // Validate email
      if (business.email && !this.emailRegex.test(business.email)) {
        errors.push({
          field: 'email',
          message: 'Invalid email format',
          severity: 'error',
          code: 'VAL-009',
          value: business.email
        });
      }

      // Validate phone
      if (business.phone && !this.phoneRegex.test(business.phone)) {
        warnings.push({
          field: 'phone',
          message: 'Phone number format may be invalid',
          severity: 'warning',
          code: 'VAL-102',
          value: business.phone
        });
      }

      // Check CAC number format
      if (business.cac_number) {
        const cacValid = this.validateCACNumber(business.cac_number);
        if (!cacValid) {
          warnings.push({
            field: 'cac_number',
            message: 'CAC number format may be invalid',
            severity: 'warning',
            code: 'VAL-103',
            value: business.cac_number
          });
        }
      }

      // Check CSID expiry
      if (business.csid_expires_at && business.csid_expires_at < new Date()) {
        errors.push({
          field: 'csid_expires_at',
          message: 'CSID has expired',
          severity: 'error',
          code: 'VAL-010',
          value: business.csid_expires_at
        });
      } else if (business.csid_expires_at) {
        const daysUntilExpiry = Math.ceil(
          (business.csid_expires_at.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );
        if (daysUntilExpiry < 30) {
          warnings.push({
            field: 'csid_expires_at',
            message: `CSID expires in ${daysUntilExpiry} days`,
            severity: 'warning',
            code: 'VAL-104',
            value: business.csid_expires_at
          });
        }
      }

      return {
        valid: errors.length === 0,
        score: this.calculateScore(errors, warnings),
        errors,
        warnings,
        recommendations: this.generateRecommendations(errors, warnings)
      };
    } catch (error) {
      logger.error('Error validating business:', error);
      throw error;
    }
  }

  /**
   * Validate document signature
   */
  async validateSignature(
    documentId: string,
    signature: string,
    publicKey: string
  ): Promise<{
    valid: boolean;
    signer?: string;
    timestamp?: Date;
    error?: string;
  }> {
    try {
      // In production, implement actual signature validation
      // This is a placeholder
      return {
        valid: true,
        signer: 'business-owner',
        timestamp: new Date()
      };
    } catch (error) {
      logger.error('Error validating signature:', error);
      return {
        valid: false,
        error: error.message
      };
    }
  }

  /**
   * Get field value from nested object
   */
  private getFieldValue(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  /**
   * Validate TIN (Tax Identification Number)
   */
  private validateTIN(tin: string): boolean {
    // TIN should be 10 digits
    return this.tinRegex.test(tin);
  }

  /**
   * Validate CAC number
   */
  private validateCACNumber(cacNumber: string): boolean {
    // CAC numbers typically start with RC, BN, etc.
    const cacRegex = /^(RC|BN|IT|LP|NC)\d{5,}$/;
    return cacRegex.test(cacNumber);
  }

  /**
   * Calculate invoice total from line items
   */
  private calculateInvoiceTotal(invoice: any): number {
    let total = 0;

    for (const item of invoice.line_items || []) {
      total += item.total || 0;
    }

    return total;
  }

  /**
   * Calculate validation score
   */
  private calculateScore(errors: ValidationIssue[], warnings: ValidationIssue[]): number {
    const errorWeight = 10;
    const warningWeight = 2;
    const maxScore = 100;

    const errorPenalty = errors.length * errorWeight;
    const warningPenalty = warnings.length * warningWeight;

    return Math.max(0, Math.min(100, maxScore - errorPenalty - warningPenalty));
  }

  /**
   * Generate recommendations based on issues
   */
  private generateRecommendations(
    errors: ValidationIssue[],
    warnings: ValidationIssue[]
  ): string[] {
    const recommendations: string[] = [];

    if (errors.length > 0) {
      recommendations.push('Fix all errors before submission to FIRS');
    }

    if (warnings.some(w => w.code === 'VAL-104')) {
      recommendations.push('Renew CSID before expiry to avoid service interruption');
    }

    if (warnings.some(w => w.code === 'VAL-103')) {
      recommendations.push('Verify CAC registration number is correct');
    }

    if (errors.some(e => e.code === 'VAL-006')) {
      recommendations.push('Ensure all quantities are positive numbers');
    }

    if (errors.some(e => e.code === 'VAL-008')) {
      recommendations.push('Review all calculations for accuracy');
    }

    return recommendations;
  }

  /**
   * Get document metadata
   */
  async getDocumentMetadata(documentId: string): Promise<DocumentMetadata | null> {
    // This would fetch from database
    // Placeholder implementation
    return {
      documentId,
      documentType: 'invoice',
      createdAt: new Date(),
      createdBy: 'system',
      version: 1,
      signatures: []
    };
  }

  /**
   * Compare two document versions
   */
  compareVersions(version1: any, version2: any): Array<{
    field: string;
    oldValue: any;
    newValue: any;
    changed: boolean;
  }> {
    const changes = [];
    const allFields = new Set([...Object.keys(version1), ...Object.keys(version2)]);

    for (const field of allFields) {
      const val1 = version1[field];
      const val2 = version2[field];

      if (JSON.stringify(val1) !== JSON.stringify(val2)) {
        changes.push({
          field,
          oldValue: val1,
          newValue: val2,
          changed: true
        });
      }
    }

    return changes;
  }
}

export const documentValidationService = new DocumentValidationService();

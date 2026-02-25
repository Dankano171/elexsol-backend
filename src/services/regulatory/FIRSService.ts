import { regulatoryLogRepository } from '../../repositories/RegulatoryLogRepository';
import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { businessRepository } from '../../repositories/BusinessRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { FIRSValidator } from '../../lib/validation/firs-validator';
import { JAdESSigner } from '../../lib/crypto/jades-signer';
import axios from 'axios';
import { format } from 'date-fns';
import xml2js from 'xml2js';
import { v4 as uuidv4 } from 'uuid';

export interface FIRSSubmission {
  id: string;
  businessId: string;
  invoiceId: string;
  submissionType: 'invoice' | 'credit_note' | 'debit_note' | 'cancellation';
  status: 'pending' | 'submitted' | 'approved' | 'rejected' | 'failed';
  irn?: string;
  qrCode?: string;
  signature?: string;
  submittedAt?: Date;
  respondedAt?: Date;
  responseCode?: string;
  responseMessage?: string;
  errors?: Array<{
    code: string;
    message: string;
    field?: string;
  }>;
  attempts: number;
  nextRetryAt?: Date;
}

export interface FIRSConfig {
  baseUrl: string;
  apiKey: string;
  clientId: string;
  clientSecret: string;
  certificatePath: string;
  privateKeyPath: string;
  csid: string;
  environment: 'sandbox' | 'production';
}

export class FIRSService {
  private config: FIRSConfig;
  private signer: JAdESSigner;
  private readonly maxRetries = 3;
  private readonly retryDelay = 300000; // 5 minutes

  constructor() {
    this.config = {
      baseUrl: process.env.FIRS_API_URL || 'https://taxpayers.ng/firs/api/v1',
      apiKey: process.env.FIRS_API_KEY || '',
      clientId: process.env.FIRS_CLIENT_ID || '',
      clientSecret: process.env.FIRS_CLIENT_SECRET || '',
      certificatePath: process.env.FIRS_CERT_PATH || '',
      privateKeyPath: process.env.FIRS_PRIVATE_KEY_PATH || '',
      csid: process.env.FIRS_CSID || '',
      environment: (process.env.FIRS_ENVIRONMENT as 'sandbox' | 'production') || 'sandbox'
    };
  }

  /**
   * Submit invoice to FIRS
   */
  async submitInvoice(
    businessId: string,
    invoiceId: string
  ): Promise<FIRSSubmission> {
    try {
      // Get invoice and business data
      const [invoice, business] = await Promise.all([
        invoiceRepository.getWithLineItems(invoiceId),
        businessRepository.findById(businessId)
      ]);

      if (!invoice || !business) {
        throw new Error('Invoice or business not found');
      }

      // Validate invoice against FIRS schema
      const validation = FIRSValidator.validate(invoice);
      if (!validation.valid) {
        await this.logFailure(invoiceId, businessId, validation.errors);
        throw new Error(`Invoice validation failed: ${validation.errors.join(', ')}`);
      }

      // Transform to FIRS XML format
      const xmlData = await this.transformToFIRSXML(invoice, business);

      // Sign with JAdES
      const signature = await this.signInvoice(xmlData, business);

      // Create submission record
      const submission = await regulatoryLogRepository.createLog({
        business_id: businessId,
        invoice_id: invoiceId,
        submission_type: 'invoice',
        request_payload: invoice,
        request_xml: xmlData,
        request_signature: signature.signature,
        metadata: {
          irn: signature.irn,
          csid: this.config.csid
        }
      });

      // Submit to FIRS
      const result = await this.submitToFIRS(submission.id, xmlData, signature);

      return result;
    } catch (error) {
      logger.error('FIRS submission error:', error);
      throw error;
    }
  }

  /**
   * Submit to FIRS API
   */
  private async submitToFIRS(
    submissionId: string,
    xmlData: string,
    signature: any
  ): Promise<FIRSSubmission> {
    const maxAttempts = 3;
    let attempt = 0;

    while (attempt < maxAttempts) {
      try {
        const response = await axios.post(
          `${this.config.baseUrl}/einvoice/submit`,
          xmlData,
          {
            headers: {
              'Content-Type': 'application/xml',
              'X-API-Key': this.config.apiKey,
              'X-CSID': this.config.csid,
              'X-Signature': signature.signature,
              'X-Timestamp': new Date().toISOString(),
              'X-Request-ID': uuidv4()
            },
            timeout: 30000
          }
        );

        // Parse response
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(response.data);

        // Check response status
        if (result?.FIRSResponse?.ResponseCode === '00') {
          // Success
          const submission = await regulatoryLogRepository.updateStatus(
            submissionId,
            'approved',
            {
              response_payload: result,
              response_xml: response.data,
              irn: result.FIRSResponse.IRN,
              qr_code: result.FIRSResponse.QRCode,
              digital_signature: result.FIRSResponse.Signature
            }
          );

          // Update invoice with FIRS data
          await invoiceRepository.markFIRSApproved(
            submission?.invoice_id!,
            result
          );

          return this.mapToSubmission(submission!);
        } else {
          // Business error from FIRS
          const error = {
            code: result.FIRSResponse.ErrorCode,
            message: result.FIRSResponse.ErrorMessage,
            field: result.FIRSResponse.ErrorField
          };

          const submission = await regulatoryLogRepository.markFailed(
            submissionId,
            error.message,
            error.code
          );

          throw new Error(`FIRS rejected: ${error.code} - ${error.message}`);
        }
      } catch (error) {
        attempt++;

        if (attempt >= maxAttempts) {
          // Mark as failed after max retries
          const submission = await regulatoryLogRepository.markFailed(
            submissionId,
            error.message,
            'MAX_RETRIES_EXCEEDED'
          );

          return this.mapToSubmission(submission!);
        }

        // Exponential backoff
        await new Promise(resolve => 
          setTimeout(resolve, this.retryDelay * Math.pow(2, attempt))
        );
      }
    }

    throw new Error('Max retries exceeded');
  }

  /**
   * Transform invoice to FIRS XML format
   */
  private async transformToFIRSXML(invoice: any, business: any): Promise<string> {
    const builder = new xml2js.Builder({
      xmldec: { version: '1.0', encoding: 'UTF-8' },
      renderOpts: { pretty: true, indent: '  ' }
    });

    const firsXML = {
      FIRSInvoice: {
        '@': {
          xmlns: 'urn:ng:firs:einvoice:1.0',
          'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance'
        },
        InvoiceHeader: {
          InvoiceNumber: invoice.invoice_number,
          InvoiceType: 'INVOICE',
          InvoiceCurrency: invoice.currency || 'NGN',
          InvoiceIssueDate: format(invoice.issue_date, "yyyy-MM-dd'T'HH:mm:ss'Z'"),
          InvoiceDueDate: format(invoice.due_date, "yyyy-MM-dd'T'HH:mm:ss'Z'"),
          InvoiceSupplyDate: invoice.supply_date ? 
            format(invoice.supply_date, "yyyy-MM-dd'T'HH:mm:ss'Z'") : undefined
        },
        SellerDetails: {
          TIN: business.tin,
          Name: business.legal_name,
          Address: business.address,
          City: business.city,
          State: business.state,
          Country: business.country,
          PostalCode: business.postal_code,
          Email: business.email,
          Phone: business.phone,
          CACNumber: business.cac_number,
          VATNumber: business.vat_number
        },
        BuyerDetails: {
          TIN: invoice.customer_tin,
          Name: invoice.customer_name,
          Address: invoice.customer_address || '',
          City: invoice.customer_city || '',
          State: invoice.customer_state || '',
          Country: invoice.customer_country || 'NG',
          Email: invoice.customer_email,
          Phone: invoice.customer_phone,
          Type: invoice.customer_type || 'BUSINESS'
        },
        LineItems: {
          LineItem: invoice.line_items?.map((item: any, index: number) => ({
            LineNumber: index + 1,
            ItemCode: item.item_code,
            ItemDescription: item.description,
            Quantity: item.quantity,
            UnitOfMeasure: item.unit_of_measure || 'unit',
            UnitPrice: item.unit_price,
            DiscountAmount: item.discount_amount || 0,
            DiscountRate: item.discount_rate || 0,
            LineSubtotal: item.subtotal,
            VATRate: item.vat_rate || 7.5,
            VATAmount: item.vat_amount,
            LineTotal: item.total
          }))
        },
        Totals: {
          TotalExclusiveVAT: invoice.subtotal,
          TotalVATAmount: invoice.vat_amount,
          TotalDiscountAmount: invoice.discount_amount,
          TotalPayableAmount: invoice.total_amount,
          AmountInWords: this.numberToWords(invoice.total_amount)
        },
        PaymentDetails: {
          PaymentMethod: invoice.payment_method || 'TRANSFER',
          PaymentTerms: invoice.terms,
          PaymentReference: invoice.payment_reference
        }
      }
    };

    return builder.buildObject(firsXML);
  }

  /**
   * Sign invoice with JAdES
   */
  private async signInvoice(xmlData: string, business: any): Promise<any> {
    // Initialize signer with business certificates
    const signer = new JAdESSigner(
      business.private_key || this.config.privateKeyPath,
      business.certificate || this.config.certificatePath,
      business.csid || this.config.csid
    );

    // Generate IRN (Invoice Reference Number)
    const irn = this.generateIRN(business.tin);

    // Sign the invoice
    const signature = await signer.signInvoice(
      { xml: xmlData },
      irn
    );

    return {
      signature: signature.signature,
      irn,
      signingTime: signature.signingTime
    };
  }

  /**
   * Generate IRN
   */
  private generateIRN(tin: string): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2, 10).toUpperCase();
    return `FIRS${tin}${timestamp}${random}`;
  }

  /**
   * Check submission status
   */
  async checkStatus(submissionId: string): Promise<FIRSSubmission> {
    try {
      const submission = await regulatoryLogRepository.findById(submissionId);
      
      if (!submission) {
        throw new Error('Submission not found');
      }

      // Query FIRS for status
      const response = await axios.get(
        `${this.config.baseUrl}/einvoice/status/${submission.irn}`,
        {
          headers: {
            'X-API-Key': this.config.apiKey,
            'X-CSID': this.config.csid
          }
        }
      );

      // Update status based on response
      let status: 'pending' | 'approved' | 'rejected' = 'pending';
      if (response.data.Status === 'APPROVED') {
        status = 'approved';
      } else if (response.data.Status === 'REJECTED') {
        status = 'rejected';
      }

      if (status !== 'pending') {
        const updated = await regulatoryLogRepository.updateStatus(
          submissionId,
          status,
          {
            response_payload: response.data
          }
        );

        if (status === 'approved') {
          await invoiceRepository.markFIRSApproved(
            submission.invoice_id!,
            response.data
          );
        } else if (status === 'rejected') {
          await invoiceRepository.markFIRSRejected(
            submission.invoice_id!,
            { errors: response.data.Errors }
          );
        }

        return this.mapToSubmission(updated!);
      }

      return this.mapToSubmission(submission);
    } catch (error) {
      logger.error('Error checking FIRS status:', error);
      throw error;
    }
  }

  /**
   * Cancel invoice in FIRS
   */
  async cancelInvoice(
    businessId: string,
    invoiceId: string,
    reason: string
  ): Promise<FIRSSubmission> {
    try {
      const invoice = await invoiceRepository.findById(invoiceId);
      
      if (!invoice || !invoice.firs_irn) {
        throw new Error('Invoice not found or not submitted to FIRS');
      }

      // Create cancellation request
      const cancellationRequest = {
        IRN: invoice.firs_irn,
        CancellationReason: reason,
        CancellationDate: format(new Date(), "yyyy-MM-dd'T'HH:mm:ss'Z'")
      };

      // Submit cancellation
      const response = await axios.post(
        `${this.config.baseUrl}/einvoice/cancel`,
        cancellationRequest,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.config.apiKey,
            'X-CSID': this.config.csid
          }
        }
      );

      // Log cancellation
      const submission = await regulatoryLogRepository.createLog({
        business_id: businessId,
        invoice_id: invoiceId,
        submission_type: 'cancellation',
        request_payload: cancellationRequest,
        metadata: {
          irn: invoice.firs_irn,
          reason
        }
      });

      if (response.data.ResponseCode === '00') {
        const updated = await regulatoryLogRepository.updateStatus(
          submission.id,
          'approved',
          {
            response_payload: response.data
          }
        );

        return this.mapToSubmission(updated!);
      } else {
        throw new Error(`Cancellation failed: ${response.data.ErrorMessage}`);
      }
    } catch (error) {
      logger.error('Error cancelling invoice in FIRS:', error);
      throw error;
    }
  }

  /**
   * Get CSID status
   */
  async getCSIDStatus(businessId: string): Promise<{
    csid: string;
    status: 'active' | 'expired' | 'pending';
    expiresAt?: Date;
  }> {
    const business = await businessRepository.findById(businessId);
    
    if (!business) {
      throw new Error('Business not found');
    }

    return {
      csid: business.csid || this.config.csid,
      status: business.csid_expires_at && business.csid_expires_at > new Date() 
        ? 'active' 
        : business.csid ? 'expired' : 'pending',
      expiresAt: business.csid_expires_at
    };
  }

  /**
   * Log submission failure
   */
  private async logFailure(
    invoiceId: string,
    businessId: string,
    errors: string[]
  ): Promise<void> {
    await regulatoryLogRepository.createLog({
      business_id: businessId,
      invoice_id: invoiceId,
      submission_type: 'invoice',
      request_payload: { errors },
      metadata: {
        error_type: 'validation',
        errors
      }
    });
  }

  /**
   * Map to submission object
   */
  private mapToSubmission(log: any): FIRSSubmission {
    return {
      id: log.id,
      businessId: log.business_id,
      invoiceId: log.invoice_id,
      submissionType: log.submission_type,
      status: log.status,
      irn: log.irn,
      qrCode: log.qr_code,
      signature: log.digital_signature,
      submittedAt: log.submitted_at,
      respondedAt: log.responded_at,
      responseCode: log.error_code,
      responseMessage: log.error_message,
      errors: log.validation_errors,
      attempts: log.attempts,
      nextRetryAt: log.next_retry_at
    };
  }

  /**
   * Convert number to words (simplified)
   */
  private numberToWords(num: number): string {
    // This is a placeholder - implement actual number-to-words conversion
    return `${num} Naira only`;
  }
}

export const firsService = new FIRSService();

import { Job } from 'bullmq';
import { queueService } from './QueueService';
import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { firsService } from '../regulatory/FIRSService';
import { notificationService } from '../notification/NotificationService';
import { logger } from '../../config/logger';

export interface InvoiceJobData {
  invoiceId: string;
  businessId: string;
  action: 'process' | 'submit-firs' | 'generate-pdf' | 'send-reminder' | 'mark-overdue';
  metadata?: Record<string, any>;
}

export interface InvoiceBatchJobData {
  invoiceIds: string[];
  businessId: string;
  action: string;
  metadata?: Record<string, any>;
}

export class InvoiceQueue {
  private readonly queueName = 'invoice-processing';
  private initialized = false;

  /**
   * Initialize invoice queue
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create queue
    queueService.createQueue({
      name: this.queueName,
      concurrency: 5,
      maxRetries: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      },
      timeout: 60000 // 1 minute
    });

    // Create worker
    queueService.createWorker<InvoiceJobData>(
      this.queueName,
      this.processInvoice.bind(this),
      {
        concurrency: 5
      }
    );

    this.initialized = true;
    logger.info('Invoice queue initialized');
  }

  /**
   * Process invoice job
   */
  private async processInvoice(job: Job<InvoiceJobData>): Promise<any> {
    const { data } = job;

    logger.debug('Processing invoice job', {
      jobId: job.id,
      invoiceId: data.invoiceId,
      action: data.action,
      attempt: job.attemptsMade
    });

    switch (data.action) {
      case 'process':
        return this.processNewInvoice(data);
      case 'submit-firs':
        return this.submitToFIRS(data);
      case 'generate-pdf':
        return this.generatePDF(data);
      case 'send-reminder':
        return this.sendReminder(data);
      case 'mark-overdue':
        return this.markOverdue(data);
      default:
        throw new Error(`Unknown action: ${data.action}`);
    }
  }

  /**
   * Process new invoice
   */
  private async processNewInvoice(data: InvoiceJobData): Promise<any> {
    const { invoiceId, businessId } = data;

    // Get invoice
    const invoice = await invoiceRepository.getWithLineItems(invoiceId);
    if (!invoice) {
      throw new Error(`Invoice ${invoiceId} not found`);
    }

    // Queue FIRS submission
    await this.addToQueue({
      invoiceId,
      businessId,
      action: 'submit-firs'
    }, 5000); // Delay 5 seconds

    // Queue PDF generation
    await this.addToQueue({
      invoiceId,
      businessId,
      action: 'generate-pdf'
    });

    return { processed: true };
  }

  /**
   * Submit invoice to FIRS
   */
  private async submitToFIRS(data: InvoiceJobData): Promise<any> {
    const { invoiceId, businessId } = data;

    const result = await firsService.submitInvoice(businessId, invoiceId);
    
    return result;
  }

  /**
   * Generate PDF for invoice
   */
  private async generatePDF(data: InvoiceJobData): Promise<any> {
    const { invoiceId } = data;

    // PDF generation logic would go here
    // This is a placeholder
    return { pdfUrl: `https://storage.elexsol.com/invoices/${invoiceId}.pdf` };
  }

  /**
   * Send payment reminder
   */
  private async sendReminder(data: InvoiceJobData): Promise<any> {
    const { invoiceId, businessId } = data;

    const invoice = await invoiceRepository.findById(invoiceId);
    if (!invoice) {
      throw new Error(`Invoice ${invoiceId} not found`);
    }

    // Send notification
    await notificationService.send({
      businessId,
      type: 'action_required',
      title: 'Payment Reminder',
      body: `Invoice ${invoice.invoice_number} is due soon`,
      data: { invoiceId, amount: invoice.balance_due },
      priority: 'medium'
    });

    return { reminderSent: true };
  }

  /**
   * Mark invoice as overdue
   */
  private async markOverdue(data: InvoiceJobData): Promise<any> {
    const { invoiceId } = data;

    const updated = await invoiceRepository.update(invoiceId, {
      payment_status: 'overdue'
    });

    return { markedOverdue: true };
  }

  /**
   * Add invoice job to queue
   */
  async addToQueue(data: InvoiceJobData, delay?: number): Promise<Job<InvoiceJobData>> {
    await this.ensureInitialized();

    return queueService.addJob<InvoiceJobData>(
      this.queueName,
      `invoice-${data.action}`,
      data,
      {
        jobId: `invoice-${data.action}-${data.invoiceId}`,
        delay,
        attempts: 3
      }
    );
  }

  /**
   * Add batch job
   */
  async addBatch(data: InvoiceBatchJobData): Promise<Job<InvoiceBatchJobData>> {
    await this.ensureInitialized();

    return queueService.addJob<InvoiceBatchJobData>(
      this.queueName,
      `invoice-batch-${data.action}`,
      data,
      {
        jobId: `invoice-batch-${data.action}-${Date.now()}`,
        attempts: 2
      }
    );
  }

  /**
   * Process overdue invoices
   */
  async scheduleOverdueCheck(): Promise<void> {
    await this.ensureInitialized();

    // This would be called by a cron job
    const overdueInvoices = await invoiceRepository.findOverdue('all');
    
    for (const invoice of overdueInvoices) {
      await this.addToQueue({
        invoiceId: invoice.id,
        businessId: invoice.business_id,
        action: 'mark-overdue'
      });
    }

    logger.info(`Scheduled overdue check for ${overdueInvoices.length} invoices`);
  }

  /**
   * Get queue metrics
   */
  async getMetrics(): Promise<any> {
    await this.ensureInitialized();
    return queueService.getMetrics(this.queueName);
  }

  /**
   * Get job status
   */
  async getJobStatus(invoiceId: string, action: string): Promise<any> {
    await this.ensureInitialized();

    const jobId = `invoice-${action}-${invoiceId}`;
    const job = await queueService.getJob(this.queueName, jobId);

    if (!job) return null;

    const state = await job.getState();

    return {
      jobId: job.id,
      status: state,
      attempts: job.attemptsMade,
      error: job.failedReason,
      result: job.returnvalue
    };
  }

  /**
   * Ensure queue is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

export const invoiceQueue = new InvoiceQueue();

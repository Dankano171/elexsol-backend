import { Request, Response } from 'express';
import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { invoiceQueue } from '../../services/queue/InvoiceQueue';
import { firsService } from '../../services/regulatory/FIRSService';
import { auditLogRepository } from '../../repositories/AuditLogRepository';
import { logger } from '../../config/logger';
import { permissionService } from '../../services/auth/PermissionService';

export class InvoiceController {
  /**
   * Create invoice
   */
  async createInvoice(req: Request, res: Response): Promise<void> {
    try {
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'invoice:create'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const invoiceData = {
        ...req.body,
        business_id: req.user.business_id
      };

      const invoice = await invoiceRepository.createInvoice(invoiceData, req.user.id);

      // Queue for processing
      await invoiceQueue.addToQueue({
        invoiceId: invoice.id,
        businessId: req.user.business_id,
        action: 'process'
      });

      // Log audit
      await auditLogRepository.log({
        user_id: req.user.id,
        business_id: req.user.business_id,
        action: 'INVOICE_CREATE',
        entity_type: 'invoice',
        entity_id: invoice.id,
        metadata: { invoice_number: invoice.invoice_number }
      });

      res.status(201).json({
        success: true,
        data: invoice
      });
    } catch (error) {
      logger.error('Create invoice error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get invoice by ID
   */
  async getInvoiceById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'invoice:read',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const invoice = await invoiceRepository.getWithLineItems(id);

      if (!invoice) {
        res.status(404).json({
          success: false,
          error: 'Invoice not found'
        });
        return;
      }

      res.json({
        success: true,
        data: invoice
      });
    } catch (error) {
      logger.error('Get invoice error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update invoice
   */
  async updateInvoice(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'invoice:update',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const invoice = await invoiceRepository.findById(id);

      if (!invoice) {
        res.status(404).json({
          success: false,
          error: 'Invoice not found'
        });
        return;
      }

      if (invoice.firs_status === 'approved') {
        res.status(400).json({
          success: false,
          error: 'Cannot update invoice already approved by FIRS'
        });
        return;
      }

      const updates = req.body;
      const updated = await invoiceRepository.update(id, updates);

      // Log audit
      await auditLogRepository.log({
        user_id: req.user.id,
        business_id: req.user.business_id,
        action: 'INVOICE_UPDATE',
        entity_type: 'invoice',
        entity_id: id,
        metadata: { updates }
      });

      res.json({
        success: true,
        data: updated
      });
    } catch (error) {
      logger.error('Update invoice error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Delete invoice
   */
  async deleteInvoice(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'invoice:delete',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const invoice = await invoiceRepository.findById(id);

      if (!invoice) {
        res.status(404).json({
          success: false,
          error: 'Invoice not found'
        });
        return;
      }

      if (invoice.firs_status === 'approved') {
        res.status(400).json({
          success: false,
          error: 'Cannot delete invoice already approved by FIRS'
        });
        return;
      }

      await invoiceRepository.softDelete(id);

      // Log audit
      await auditLogRepository.log({
        user_id: req.user.id,
        business_id: req.user.business_id,
        action: 'INVOICE_DELETE',
        entity_type: 'invoice',
        entity_id: id,
        metadata: {}
      });

      res.json({
        success: true,
        message: 'Invoice deleted successfully'
      });
    } catch (error) {
      logger.error('Delete invoice error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get all invoices
   */
  async getAllInvoices(req: Request, res: Response): Promise<void> {
    try {
      const {
        page = 1,
        limit = 20,
        status,
        payment_status,
        fromDate,
        toDate,
        customerTin
      } = req.query;

      const result = await invoiceRepository.getByBusiness(
        req.user.business_id,
        {
          status: status as any,
          payment_status: payment_status as any,
          fromDate: fromDate ? new Date(fromDate as string) : undefined,
          toDate: toDate ? new Date(toDate as string) : undefined,
          customerTin: customerTin as string,
          limit: Number(limit),
          offset: (Number(page) - 1) * Number(limit)
        }
      );

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Get all invoices error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Submit to FIRS
   */
  async submitToFIRS(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'invoice:update',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const invoice = await invoiceRepository.findById(id);

      if (!invoice) {
        res.status(404).json({
          success: false,
          error: 'Invoice not found'
        });
        return;
      }

      if (invoice.firs_status !== 'pending') {
        res.status(400).json({
          success: false,
          error: `Invoice already ${invoice.firs_status} to FIRS`
        });
        return;
      }

      const submission = await firsService.submitInvoice(
        req.user.business_id,
        id
      );

      res.json({
        success: true,
        data: submission
      });
    } catch (error) {
      logger.error('Submit to FIRS error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Check FIRS status
   */
  async checkFIRSStatus(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'invoice:read',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const invoice = await invoiceRepository.findById(id);

      if (!invoice) {
        res.status(404).json({
          success: false,
          error: 'Invoice not found'
        });
        return;
      }

      if (!invoice.firs_irn) {
        res.status(400).json({
          success: false,
          error: 'Invoice not submitted to FIRS'
        });
        return;
      }

      // In production, query FIRS for status
      // Placeholder response
      res.json({
        success: true,
        data: {
          status: invoice.firs_status,
          irn: invoice.firs_irn,
          submitted_at: invoice.submitted_at,
          approved_at: invoice.approved_at
        }
      });
    } catch (error) {
      logger.error('Check FIRS status error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Cancel invoice
   */
  async cancelInvoice(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'invoice:update',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const invoice = await invoiceRepository.cancel(id, reason);

      if (!invoice) {
        res.status(404).json({
          success: false,
          error: 'Invoice not found'
        });
        return;
      }

      // Log audit
      await auditLogRepository.log({
        user_id: req.user.id,
        business_id: req.user.business_id,
        action: 'INVOICE_CANCEL',
        entity_type: 'invoice',
        entity_id: id,
        metadata: { reason }
      });

      res.json({
        success: true,
        data: invoice
      });
    } catch (error) {
      logger.error('Cancel invoice error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Search invoices
   */
  async searchInvoices(req: Request, res: Response): Promise<void> {
    try {
      const { q } = req.query;

      if (!q || typeof q !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Search query required'
        });
        return;
      }

      const invoices = await invoiceRepository.search(
        req.user.business_id,
        q
      );

      res.json({
        success: true,
        data: invoices
      });
    } catch (error) {
      logger.error('Search invoices error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get invoice statistics
   */
  async getStatistics(req: Request, res: Response): Promise<void> {
    try {
      const { fromDate, toDate } = req.query;

      const stats = await invoiceRepository.getStatistics(
        req.user.business_id,
        fromDate ? new Date(fromDate as string) : undefined,
        toDate ? new Date(toDate as string) : undefined
      );

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('Get invoice statistics error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get aging report
   */
  async getAgingReport(req: Request, res: Response): Promise<void> {
    try {
      const report = await invoiceRepository.getAgingReport(req.user.business_id);

      res.json({
        success: true,
        data: report
      });
    } catch (error) {
      logger.error('Get aging report error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Download invoice PDF
   */
  async downloadPDF(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'invoice:read',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const invoice = await invoiceRepository.findById(id);

      if (!invoice) {
        res.status(404).json({
          success: false,
          error: 'Invoice not found'
        });
        return;
      }

      // Generate PDF (placeholder)
      const pdfBuffer = Buffer.from('PDF content placeholder');

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=invoice-${invoice.invoice_number}.pdf`);
      res.send(pdfBuffer);
    } catch (error) {
      logger.error('Download PDF error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const invoiceController = new InvoiceController();

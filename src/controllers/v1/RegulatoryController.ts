import { Request, Response } from 'express';
import { firsService } from '../../services/regulatory/FIRSService';
import { complianceService } from '../../services/regulatory/ComplianceService';
import { taxCalculationService } from '../../services/regulatory/TaxCalculationService';
import { documentValidationService } from '../../services/regulatory/DocumentValidationService';
import { regulatoryReportingService } from '../../services/regulatory/RegulatoryReportingService';
import { peppolService } from '../../services/regulatory/PeppolService';
import { logger } from '../../config/logger';
import { permissionService } from '../../services/auth/PermissionService';

export class RegulatoryController {
  /**
   * Get compliance status
   */
  async getComplianceStatus(req: Request, res: Response): Promise<void> {
    try {
      const status = await complianceService.getComplianceStatus(req.user.business_id);

      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      logger.error('Get compliance status error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get CSID status
   */
  async getCSIDStatus(req: Request, res: Response): Promise<void> {
    try {
      const status = await firsService.getCSIDStatus(req.user.business_id);

      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      logger.error('Get CSID status error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Submit invoice to FIRS
   */
  async submitToFIRS(req: Request, res: Response): Promise<void> {
    try {
      const { invoiceId } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'invoice:update',
        invoiceId
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const submission = await firsService.submitInvoice(
        req.user.business_id,
        invoiceId
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
   * Check submission status
   */
  async checkSubmissionStatus(req: Request, res: Response): Promise<void> {
    try {
      const { submissionId } = req.params;

      const status = await firsService.checkStatus(submissionId);

      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      logger.error('Check submission status error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Cancel invoice in FIRS
   */
  async cancelInvoice(req: Request, res: Response): Promise<void> {
    try {
      const { invoiceId } = req.params;
      const { reason } = req.body;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'invoice:update',
        invoiceId
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const result = await firsService.cancelInvoice(
        req.user.business_id,
        invoiceId,
        reason
      );

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Cancel invoice error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Validate invoice document
   */
  async validateInvoice(req: Request, res: Response): Promise<void> {
    try {
      const { invoiceId } = req.params;
      const { strict = false } = req.query;

      const validation = await documentValidationService.validateInvoice(
        invoiceId,
        { strict: strict === 'true' }
      );

      res.json({
        success: true,
        data: validation
      });
    } catch (error) {
      logger.error('Validate invoice error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Validate business registration
   */
  async validateBusiness(req: Request, res: Response): Promise<void> {
    try {
      const validation = await documentValidationService.validateBusiness(
        req.user.business_id
      );

      res.json({
        success: true,
        data: validation
      });
    } catch (error) {
      logger.error('Validate business error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Calculate tax for invoice
   */
  async calculateTax(req: Request, res: Response): Promise<void> {
    try {
      const invoiceData = req.body;

      const taxBreakdown = await taxCalculationService.calculateInvoiceTax(
        req.user.business_id,
        invoiceData
      );

      res.json({
        success: true,
        data: taxBreakdown
      });
    } catch (error) {
      logger.error('Calculate tax error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Generate tax report
   */
  async generateTaxReport(req: Request, res: Response): Promise<void> {
    try {
      const { fromDate, toDate } = req.query;

      if (!fromDate || !toDate) {
        res.status(400).json({
          success: false,
          error: 'fromDate and toDate are required'
        });
        return;
      }

      const report = await taxCalculationService.generateTaxReport(
        req.user.business_id,
        new Date(fromDate as string),
        new Date(toDate as string)
      );

      res.json({
        success: true,
        data: report
      });
    } catch (error) {
      logger.error('Generate tax report error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Calculate VAT liability
   */
  async calculateVATLiability(req: Request, res: Response): Promise<void> {
    try {
      const { fromDate, toDate } = req.query;

      if (!fromDate || !toDate) {
        res.status(400).json({
          success: false,
          error: 'fromDate and toDate are required'
        });
        return;
      }

      const liability = await taxCalculationService.calculateVATLiability(
        req.user.business_id,
        new Date(fromDate as string),
        new Date(toDate as string)
      );

      res.json({
        success: true,
        data: liability
      });
    } catch (error) {
      logger.error('Calculate VAT liability error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Generate VAT return
   */
  async generateVATReturn(req: Request, res: Response): Promise<void> {
    try {
      const { year, month } = req.query;

      if (!year || !month) {
        res.status(400).json({
          success: false,
          error: 'year and month are required'
        });
        return;
      }

      const buffer = await taxCalculationService.generateVATReturn(
        req.user.business_id,
        {
          year: Number(year),
          month: Number(month)
        }
      );

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=vat-return-${year}-${month}.csv`);
      res.send(buffer);
    } catch (error) {
      logger.error('Generate VAT return error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Generate regulatory report
   */
  async generateReport(req: Request, res: Response): Promise<void> {
    try {
      const { type = 'monthly', fromDate, toDate } = req.query;

      if (!fromDate || !toDate) {
        res.status(400).json({
          success: false,
          error: 'fromDate and toDate are required'
        });
        return;
      }

      const report = await regulatoryReportingService.generateReport(
        req.user.business_id,
        {
          from: new Date(fromDate as string),
          to: new Date(toDate as string)
        },
        type as any
      );

      res.json({
        success: true,
        data: report
      });
    } catch (error) {
      logger.error('Generate report error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get report history
   */
  async getReportHistory(req: Request, res: Response): Promise<void> {
    try {
      const { limit = 12 } = req.query;

      const history = await regulatoryReportingService.getReportHistory(
        req.user.business_id,
        Number(limit)
      );

      res.json({
        success: true,
        data: history
      });
    } catch (error) {
      logger.error('Get report history error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Export regulatory report
   */
  async exportReport(req: Request, res: Response): Promise<void> {
    try {
      const { reportId, format = 'pdf' } = req.params;

      const buffer = await regulatoryReportingService.exportReport(
        reportId,
        format as any
      );

      res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=regulatory-report-${reportId}.${format}`);
      res.send(buffer);
    } catch (error) {
      logger.error('Export report error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Convert Peppol to FIRS
   */
  async convertPeppolToFIRS(req: Request, res: Response): Promise<void> {
    try {
      const { xml } = req.body;

      const firsData = await peppolService.convertPeppolToFIRS(xml);

      res.json({
        success: true,
        data: firsData
      });
    } catch (error) {
      logger.error('Convert Peppol to FIRS error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Convert FIRS to Peppol
   */
  async convertFIRSToPeppol(req: Request, res: Response): Promise<void> {
    try {
      const firsData = req.body;

      const peppolXml = await peppolService.convertFIRSToPeppol(firsData);

      res.setHeader('Content-Type', 'application/xml');
      res.send(peppolXml);
    } catch (error) {
      logger.error('Convert FIRS to Peppol error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Validate Peppol document
   */
  async validatePeppolDocument(req: Request, res: Response): Promise<void> {
    try {
      const { xml } = req.body;

      const validation = await peppolService.validatePeppolDocument(xml);

      res.json({
        success: true,
        data: validation
      });
    } catch (error) {
      logger.error('Validate Peppol document error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Run compliance check
   */
  async runComplianceCheck(req: Request, res: Response): Promise<void> {
    try {
      await complianceService.runComplianceCheck(req.user.business_id);

      res.json({
        success: true,
        message: 'Compliance check initiated'
      });
    } catch (error) {
      logger.error('Run compliance check error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const regulatoryController = new RegulatoryController();

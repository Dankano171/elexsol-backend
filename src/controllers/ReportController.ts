import { Request, Response } from 'express';
import { reportModel } from '../../models/Report';
import { reportGeneratorService } from '../../services/reporting/ReportGeneratorService';
import { scheduledReportService } from '../../services/reporting/ScheduledReportService';
import { reportExportService } from '../../services/reporting/ReportExportService';
import { reportAnalyticsService } from '../../services/reporting/ReportAnalyticsService';
import { reportQueue } from '../../services/queue/ReportQueue';
import { logger } from '../../config/logger';
import { permissionService } from '../../services/auth/PermissionService';

export class ReportController {
  /**
   * Create report
   */
  async createReport(req: Request, res: Response): Promise<void> {
    try {
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'report:create'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const reportData = {
        ...req.body,
        business_id: req.user.business_id,
        created_by: req.user.id
      };

      const report = await reportModel.createReport(reportData);

      // Queue for generation
      await reportQueue.addToQueue({
        reportId: report.id,
        businessId: req.user.business_id,
        type: report.type,
        format: report.format,
        parameters: report.parameters,
        userId: req.user.id
      });

      res.status(201).json({
        success: true,
        data: report
      });
    } catch (error) {
      logger.error('Create report error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get all reports
   */
  async getAllReports(req: Request, res: Response): Promise<void> {
    try {
      const {
        page = 1,
        limit = 20,
        type,
        status
      } = req.query;

      const result = await reportModel.getByBusiness(
        req.user.business_id,
        {
          type: type as any,
          status: status as any,
          limit: Number(limit),
          offset: (Number(page) - 1) * Number(limit)
        }
      );

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Get all reports error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get report by ID
   */
  async getReportById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const report = await reportModel.findOne({
        id,
        business_id: req.user.business_id
      });

      if (!report) {
        res.status(404).json({
          success: false,
          error: 'Report not found'
        });
        return;
      }

      res.json({
        success: true,
        data: report
      });
    } catch (error) {
      logger.error('Get report error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update report
   */
  async updateReport(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'report:update',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const report = await reportModel.findOne({
        id,
        business_id: req.user.business_id
      });

      if (!report) {
        res.status(404).json({
          success: false,
          error: 'Report not found'
        });
        return;
      }

      const updates = req.body;
      const updated = await reportModel.update(id, updates);

      res.json({
        success: true,
        data: updated
      });
    } catch (error) {
      logger.error('Update report error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Delete report
   */
  async deleteReport(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'report:delete',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const report = await reportModel.findOne({
        id,
        business_id: req.user.business_id
      });

      if (!report) {
        res.status(404).json({
          success: false,
          error: 'Report not found'
        });
        return;
      }

      await reportModel.softDelete(id);

      res.json({
        success: true,
        message: 'Report deleted successfully'
      });
    } catch (error) {
      logger.error('Delete report error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Generate report
   */
  async generateReport(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const report = await reportModel.findOne({
        id,
        business_id: req.user.business_id
      });

      if (!report) {
        res.status(404).json({
          success: false,
          error: 'Report not found'
        });
        return;
      }

      // Queue for generation
      await reportQueue.addToQueue({
        reportId: id,
        businessId: req.user.business_id,
        type: report.type,
        format: report.format,
        parameters: report.parameters,
        userId: req.user.id
      });

      res.json({
        success: true,
        message: 'Report generation queued'
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
   * Download report
   */
  async downloadReport(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { format = 'pdf' } = req.query;

      const report = await reportModel.findOne({
        id,
        business_id: req.user.business_id
      });

      if (!report) {
        res.status(404).json({
          success: false,
          error: 'Report not found'
        });
        return;
      }

      if (!report.file_url) {
        res.status(400).json({
          success: false,
          error: 'Report not yet generated'
        });
        return;
      }

      // In production, redirect to file URL or stream file
      res.redirect(report.file_url);
    } catch (error) {
      logger.error('Download report error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Schedule report
   */
  async scheduleReport(req: Request, res: Response): Promise<void> {
    try {
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'report:create'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const scheduleData = {
        ...req.body,
        business_id: req.user.business_id
      };

      await reportGeneratorService.scheduleReport(scheduleData);

      res.status(201).json({
        success: true,
        message: 'Report scheduled successfully'
      });
    } catch (error) {
      logger.error('Schedule report error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get scheduled reports
   */
  async getScheduledReports(req: Request, res: Response): Promise<void> {
    try {
      const { days = 7 } = req.query;

      const reports = await scheduledReportService.getUpcomingReports(
        req.user.business_id,
        Number(days)
      );

      res.json({
        success: true,
        data: reports
      });
    } catch (error) {
      logger.error('Get scheduled reports error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Pause scheduled report
   */
  async pauseScheduledReport(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'report:update',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      await scheduledReportService.pauseReport(id);

      res.json({
        success: true,
        message: 'Scheduled report paused'
      });
    } catch (error) {
      logger.error('Pause scheduled report error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Resume scheduled report
   */
  async resumeScheduledReport(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'report:update',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      await scheduledReportService.resumeReport(id);

      res.json({
        success: true,
        message: 'Scheduled report resumed'
      });
    } catch (error) {
      logger.error('Resume scheduled report error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Export report
   */
  async exportReport(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { format = 'pdf', includeCharts = true, includeTables = true } = req.query;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'report:read',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const exportResult = await reportExportService.exportReport({
        reportId: id,
        businessId: req.user.business_id,
        format: format as any,
        includeCharts: includeCharts === 'true',
        includeTables: includeTables === 'true'
      });

      res.json({
        success: true,
        data: exportResult
      });
    } catch (error) {
      logger.error('Export report error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Download exported report
   */
  async downloadExported(req: Request, res: Response): Promise<void> {
    try {
      const { exportId } = req.params;

      const { buffer, filename } = await reportExportService.downloadExport(exportId);

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      res.send(buffer);
    } catch (error) {
      logger.error('Download exported error:', error);
      res.status(404).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get report analytics
   */
  async getAnalytics(req: Request, res: Response): Promise<void> {
    try {
      const { days = 30 } = req.query;

      const analytics = await reportAnalyticsService.getAnalytics(
        req.user.business_id,
        Number(days)
      );

      res.json({
        success: true,
        data: analytics
      });
    } catch (error) {
      logger.error('Get analytics error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get report history
   */
  async getExportHistory(req: Request, res: Response): Promise<void> {
    try {
      const { limit = 10 } = req.query;

      const history = await reportExportService.getExportHistory(
        req.user.business_id,
        Number(limit)
      );

      res.json({
        success: true,
        data: history
      });
    } catch (error) {
      logger.error('Get export history error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Duplicate report
   */
  async duplicateReport(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { name } = req.body;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'report:create'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const duplicated = await reportModel.duplicate(id, name, req.user.id);

      res.status(201).json({
        success: true,
        data: duplicated
      });
    } catch (error) {
      logger.error('Duplicate report error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const reportController = new ReportController();

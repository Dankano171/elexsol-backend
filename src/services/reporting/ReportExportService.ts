import { reportGeneratorService } from './ReportGeneratorService';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

export interface ExportOptions {
  reportId: string;
  businessId: string;
  format: 'pdf' | 'excel' | 'csv' | 'json';
  includeCharts?: boolean;
  includeTables?: boolean;
  password?: string;
  watermark?: string;
  compression?: boolean;
}

export interface ExportResult {
  exportId: string;
  reportId: string;
  format: string;
  fileUrl: string;
  fileSize: number;
  expiresAt: Date;
  downloadCount: number;
}

export class ReportExportService {
  private readonly exportTTL = 7 * 24 * 60 * 60; // 7 days
  private readonly maxExportsPerDay = 100;

  /**
   * Export report
   */
  async exportReport(options: ExportOptions): Promise<ExportResult> {
    try {
      // Check rate limit
      await this.checkRateLimit(options.businessId);

      // Get report data
      const report = await reportModel.findById(options.reportId);
      if (!report) {
        throw new Error('Report not found');
      }

      // Generate report data
      const reportData = await reportGeneratorService.generateReport({
        id: report.id,
        businessId: report.business_id,
        name: report.name,
        type: report.type,
        format: options.format,
        parameters: report.parameters
      });

      // Apply options
      if (!options.includeCharts) {
        reportData.charts = [];
      }
      if (!options.includeTables) {
        reportData.tables = [];
      }

      // Export to file
      const fileBuffer = await reportGeneratorService.exportReport(
        reportData,
        options.format
      );

      // Apply password protection if needed
      let finalBuffer = fileBuffer;
      if (options.password) {
        finalBuffer = await this.applyPassword(finalBuffer, options.format, options.password);
      }

      // Apply watermark if needed
      if (options.watermark) {
        finalBuffer = await this.applyWatermark(finalBuffer, options.format, options.watermark);
      }

      // Apply compression if needed
      if (options.compression) {
        finalBuffer = await this.compress(finalBuffer);
      }

      // Store file (in production, upload to S3/MinIO)
      const fileUrl = await this.storeFile(
        options.reportId,
        options.format,
        finalBuffer
      );

      // Create export record
      const exportId = `export-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const expiresAt = new Date();
      expiresAt.setSeconds(expiresAt.getSeconds() + this.exportTTL);

      const result: ExportResult = {
        exportId,
        reportId: options.reportId,
        format: options.format,
        fileUrl,
        fileSize: finalBuffer.length,
        expiresAt,
        downloadCount: 0
      };

      // Store export metadata
      await this.storeExportMetadata(exportId, result);

      logger.info('Report exported successfully', {
        exportId,
        reportId: options.reportId,
        format: options.format,
        size: finalBuffer.length
      });

      return result;
    } catch (error) {
      logger.error('Error exporting report:', error);
      throw error;
    }
  }

  /**
   * Get export by ID
   */
  async getExport(exportId: string): Promise<ExportResult | null> {
    const key = `export:${exportId}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Download export
   */
  async downloadExport(exportId: string): Promise<{ buffer: Buffer; filename: string }> {
    const exportData = await this.getExport(exportId);
    if (!exportData) {
      throw new Error('Export not found');
    }

    if (new Date() > exportData.expiresAt) {
      throw new Error('Export has expired');
    }

    // Increment download count
    await this.incrementDownloadCount(exportId);

    // Get file from storage (in production, download from S3/MinIO)
    const buffer = await this.getFile(exportData.fileUrl);

    const filename = `report-${exportData.reportId}-${format(new Date(), 'yyyyMMdd')}.${exportData.format}`;

    return { buffer, filename };
  }

  /**
   * Get export history
   */
  async getExportHistory(
    businessId: string,
    limit: number = 10
  ): Promise<ExportResult[]> {
    const pattern = `export:*`;
    const keys = await redis.keys(pattern);
    const exports: ExportResult[] = [];

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const exp = JSON.parse(data);
        if (exp.businessId === businessId) {
          exports.push(exp);
        }
      }
    }

    return exports
      .sort((a, b) => new Date(b.expiresAt).getTime() - new Date(a.expiresAt).getTime())
      .slice(0, limit);
  }

  /**
   * Delete expired exports
   */
  async deleteExpiredExports(): Promise<number> {
    const pattern = `export:*`;
    const keys = await redis.keys(pattern);
    let deleted = 0;

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const exp = JSON.parse(data);
        if (new Date() > new Date(exp.expiresAt)) {
          await redis.del(key);
          await this.deleteFile(exp.fileUrl);
          deleted++;
        }
      }
    }

    logger.info(`Deleted ${deleted} expired exports`);
    return deleted;
  }

  /**
   * Check rate limit
   */
  private async checkRateLimit(businessId: string): Promise<void> {
    const date = format(new Date(), 'yyyy-MM-dd');
    const key = `export:limit:${businessId}:${date}`;

    const count = await redis.incr(key);
    if (count === 1) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      const secondsUntilTomorrow = Math.ceil((tomorrow.getTime() - Date.now()) / 1000);
      await redis.expire(key, secondsUntilTomorrow);
    }

    if (count > this.maxExportsPerDay) {
      throw new Error('Daily export limit exceeded');
    }
  }

  /**
   * Store export metadata
   */
  private async storeExportMetadata(exportId: string, data: ExportResult): Promise<void> {
    const key = `export:${exportId}`;
    await redis.setex(key, this.exportTTL, JSON.stringify(data));
  }

  /**
   * Increment download count
   */
  private async incrementDownloadCount(exportId: string): Promise<void> {
    const key = `export:${exportId}`;
    const data = await redis.get(key);
    if (data) {
      const exp = JSON.parse(data);
      exp.downloadCount++;
      await redis.setex(key, this.exportTTL, JSON.stringify(exp));
    }
  }

  /**
   * Store file (placeholder - implement with S3/MinIO)
   */
  private async storeFile(reportId: string, format: string, buffer: Buffer): Promise<string> {
    // In production, upload to S3 or MinIO
    const url = `https://storage.elexsol.com/exports/${reportId}-${Date.now()}.${format}`;
    return url;
  }

  /**
   * Get file (placeholder - implement with S3/MinIO)
   */
  private async getFile(url: string): Promise<Buffer> {
    // In production, download from S3 or MinIO
    return Buffer.from('File content placeholder');
  }

  /**
   * Delete file (placeholder - implement with S3/MinIO)
   */
  private async deleteFile(url: string): Promise<void> {
    // In production, delete from S3 or MinIO
  }

  /**
   * Apply password protection (placeholder)
   */
  private async applyPassword(
    buffer: Buffer,
    format: string,
    password: string
  ): Promise<Buffer> {
    // In production, use appropriate libraries (pdf-lib for PDF, etc.)
    return buffer;
  }

  /**
   * Apply watermark (placeholder)
   */
  private async applyWatermark(
    buffer: Buffer,
    format: string,
    watermark: string
  ): Promise<Buffer> {
    // In production, add watermark to document
    return buffer;
  }

  /**
   * Compress buffer (placeholder)
   */
  private async compress(buffer: Buffer): Promise<Buffer> {
    // In production, use zlib or similar
    return buffer;
  }
}

export const reportExportService = new ReportExportService();

// Helper function for date formatting
function format(date: Date, formatStr: string): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  
  return formatStr
    .replace('yyyy', year.toString())
    .replace('MM', month)
    .replace('dd', day);
}

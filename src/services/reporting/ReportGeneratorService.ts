import { reportModel } from '../../models/Report';
import { businessRepository } from '../../repositories/BusinessRepository';
import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { transactionRepository } from '../../repositories/TransactionRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { format, subDays, subMonths, startOfMonth, endOfMonth } from 'date-fns';
import ExcelJS from 'exceljs';
import PDFKit from 'pdfkit';
import { Readable } from 'stream';

export interface ReportConfig {
  id: string;
  businessId: string;
  name: string;
  type: 'financial' | 'tax' | 'customer' | 'operational' | 'custom';
  format: 'pdf' | 'excel' | 'csv' | 'json';
  schedule?: {
    frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly';
    dayOfWeek?: number;
    dayOfMonth?: number;
    time: string;
    recipients: string[];
  };
  parameters: {
    fromDate?: Date;
    toDate?: Date;
    filters?: Record<string, any>;
    groupBy?: string[];
    metrics?: string[];
    comparisons?: boolean;
  };
}

export interface ReportData {
  metadata: {
    reportId: string;
    businessId: string;
    businessName: string;
    generatedAt: Date;
    period: {
      from: Date;
      to: Date;
    };
    type: string;
  };
  summary: Record<string, any>;
  sections: ReportSection[];
  charts?: ChartData[];
  tables?: TableData[];
}

export interface ReportSection {
  id: string;
  title: string;
  description?: string;
  data: any;
  type: 'summary' | 'table' | 'chart' | 'metrics';
}

export interface ChartData {
  id: string;
  type: 'line' | 'bar' | 'pie' | 'area';
  title: string;
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    color?: string;
  }>;
}

export interface TableData {
  id: string;
  title: string;
  headers: string[];
  rows: any[][];
  totals?: Record<string, number>;
}

export class ReportGeneratorService {
  private readonly cacheTTL = 3600; // 1 hour

  /**
   * Generate report
   */
  async generateReport(config: ReportConfig): Promise<ReportData> {
    try {
      // Get business info
      const business = await businessRepository.findById(config.businessId);
      if (!business) {
        throw new Error('Business not found');
      }

      // Set date range if not provided
      const fromDate = config.parameters.fromDate || subDays(new Date(), 30);
      const toDate = config.parameters.toDate || new Date();

      // Generate report data based on type
      let reportData: Partial<ReportData> = {
        metadata: {
          reportId: config.id,
          businessId: config.businessId,
          businessName: business.name,
          generatedAt: new Date(),
          period: { from: fromDate, to: toDate },
          type: config.type
        },
        sections: []
      };

      switch (config.type) {
        case 'financial':
          reportData = await this.generateFinancialReport(reportData, config, business);
          break;
        case 'tax':
          reportData = await this.generateTaxReport(reportData, config, business);
          break;
        case 'customer':
          reportData = await this.generateCustomerReport(reportData, config, business);
          break;
        case 'operational':
          reportData = await this.generateOperationalReport(reportData, config, business);
          break;
        default:
          reportData = await this.generateCustomReport(reportData, config, business);
      }

      // Add summary
      reportData.summary = this.extractSummary(reportData);

      return reportData as ReportData;
    } catch (error) {
      logger.error('Error generating report:', error);
      throw error;
    }
  }

  /**
   * Generate financial report
   */
  private async generateFinancialReport(
    reportData: Partial<ReportData>,
    config: ReportConfig,
    business: any
  ): Promise<Partial<ReportData>> {
    const { fromDate, toDate } = reportData.metadata!.period;

    // Get data
    const [invoices, transactions] = await Promise.all([
      invoiceRepository.findByDateRange(config.businessId, fromDate, toDate),
      transactionRepository.findByBusiness(config.businessId, {
        fromDate,
        toDate,
        status: 'completed'
      })
    ]);

    // Revenue section
    const revenueByMonth = this.aggregateByMonth(invoices, 'total_amount');
    reportData.sections!.push({
      id: 'revenue-overview',
      title: 'Revenue Overview',
      type: 'metrics',
      data: {
        total: invoices.reduce((sum, inv) => sum + inv.total_amount, 0),
        average: invoices.length > 0 
          ? invoices.reduce((sum, inv) => sum + inv.total_amount, 0) / invoices.length 
          : 0,
        count: invoices.length,
        byMonth: revenueByMonth
      }
    });

    // Chart data
    const chartData: ChartData = {
      id: 'revenue-trend',
      type: 'line',
      title: 'Revenue Trend',
      labels: revenueByMonth.map(m => m.month),
      datasets: [{
        label: 'Revenue',
        data: revenueByMonth.map(m => m.total)
      }]
    };
    
    if (!reportData.charts) reportData.charts = [];
    reportData.charts.push(chartData);

    // Payment methods table
    const paymentMethods = this.aggregatePaymentMethods(transactions);
    const tableData: TableData = {
      id: 'payment-methods',
      title: 'Payment Methods Breakdown',
      headers: ['Method', 'Count', 'Amount', 'Percentage'],
      rows: paymentMethods.map(m => [
        m.method,
        m.count,
        m.amount,
        `${m.percentage}%`
      ]),
      totals: {
        'Count': paymentMethods.reduce((sum, m) => sum + m.count, 0),
        'Amount': paymentMethods.reduce((sum, m) => sum + m.amount, 0)
      }
    };
    
    if (!reportData.tables) reportData.tables = [];
    reportData.tables.push(tableData);

    return reportData;
  }

  /**
   * Generate tax report
   */
  private async generateTaxReport(
    reportData: Partial<ReportData>,
    config: ReportConfig,
    business: any
  ): Promise<Partial<ReportData>> {
    const { fromDate, toDate } = reportData.metadata!.period;

    const invoices = await invoiceRepository.findByDateRange(
      config.businessId,
      fromDate,
      toDate
    );

    // Tax summary
    const totalVAT = invoices.reduce((sum, inv) => sum + (inv.vat_amount || 0), 0);
    const taxableInvoices = invoices.filter(inv => inv.vat_amount > 0);
    const exemptInvoices = invoices.filter(inv => inv.vat_amount === 0);

    reportData.sections!.push({
      id: 'tax-summary',
      title: 'Tax Summary',
      type: 'metrics',
      data: {
        totalVAT,
        taxableInvoices: taxableInvoices.length,
        exemptInvoices: exemptInvoices.length,
        averageVAT: taxableInvoices.length > 0 
          ? totalVAT / taxableInvoices.length 
          : 0,
        filingDueDate: this.calculateFilingDueDate(toDate)
      }
    });

    // VAT by month
    const vatByMonth = this.aggregateByMonth(invoices, 'vat_amount');
    
    const chartData: ChartData = {
      id: 'vat-trend',
      type: 'bar',
      title: 'VAT Collected by Month',
      labels: vatByMonth.map(m => m.month),
      datasets: [{
        label: 'VAT Amount',
        data: vatByMonth.map(m => m.total)
      }]
    };
    
    if (!reportData.charts) reportData.charts = [];
    reportData.charts.push(chartData);

    return reportData;
  }

  /**
   * Generate customer report
   */
  private async generateCustomerReport(
    reportData: Partial<ReportData>,
    config: ReportConfig,
    business: any
  ): Promise<Partial<ReportData>> {
    const { fromDate, toDate } = reportData.metadata!.period;

    const invoices = await invoiceRepository.findByDateRange(
      config.businessId,
      fromDate,
      toDate
    );

    // Group by customer
    const customerMap = new Map();
    invoices.forEach(inv => {
      const tin = inv.customer_tin;
      if (!customerMap.has(tin)) {
        customerMap.set(tin, {
          name: inv.customer_name,
          tin,
          invoices: 0,
          total: 0,
          paid: 0
        });
      }
      const customer = customerMap.get(tin);
      customer.invoices++;
      customer.total += inv.total_amount;
      if (inv.payment_status === 'paid') {
        customer.paid += inv.total_amount;
      }
    });

    // Top customers table
    const topCustomers = Array.from(customerMap.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    const tableData: TableData = {
      id: 'top-customers',
      title: 'Top Customers by Revenue',
      headers: ['Customer', 'TIN', 'Invoices', 'Total', 'Paid', 'Outstanding'],
      rows: topCustomers.map(c => [
        c.name,
        c.tin,
        c.invoices,
        c.total,
        c.paid,
        c.total - c.paid
      ])
    };
    
    if (!reportData.tables) reportData.tables = [];
    reportData.tables.push(tableData);

    // Customer segment chart
    const segments = {
      vip: topCustomers.filter(c => c.total > 1000000).length,
      regular: topCustomers.filter(c => c.total > 100000 && c.total <= 1000000).length,
      small: topCustomers.filter(c => c.total <= 100000).length
    };

    const chartData: ChartData = {
      id: 'customer-segments',
      type: 'pie',
      title: 'Customer Segments',
      labels: ['VIP (>₦1M)', 'Regular (₦100K-₦1M)', 'Small (<₦100K)'],
      datasets: [{
        label: 'Customers',
        data: [segments.vip, segments.regular, segments.small]
      }]
    };
    
    if (!reportData.charts) reportData.charts = [];
    reportData.charts.push(chartData);

    return reportData;
  }

  /**
   * Generate operational report
   */
  private async generateOperationalReport(
    reportData: Partial<ReportData>,
    config: ReportConfig,
    business: any
  ): Promise<Partial<ReportData>> {
    const { fromDate, toDate } = reportData.metadata!.period;

    const invoices = await invoiceRepository.findByDateRange(
      config.businessId,
      fromDate,
      toDate
    );

    // Payment velocity
    const paidInvoices = invoices.filter(inv => inv.paid_at);
    const paymentDays = paidInvoices.map(inv => 
      (new Date(inv.paid_at).getTime() - new Date(inv.issue_date).getTime()) / (1000 * 60 * 60 * 24)
    );

    const avgPaymentDays = paymentDays.length > 0
      ? paymentDays.reduce((a, b) => a + b, 0) / paymentDays.length
      : 0;

    // Overdue analysis
    const overdueInvoices = invoices.filter(inv => 
      inv.payment_status === 'overdue' || 
      (inv.payment_status === 'unpaid' && new Date(inv.due_date) < new Date())
    );

    reportData.sections!.push({
      id: 'operational-metrics',
      title: 'Operational Metrics',
      type: 'metrics',
      data: {
        totalInvoices: invoices.length,
        paidInvoices: paidInvoices.length,
        overdueInvoices: overdueInvoices.length,
        averagePaymentDays,
        onTimePaymentRate: invoices.length > 0 
          ? (paidInvoices.length / invoices.length) * 100 
          : 0,
        outstandingAmount: overdueInvoices.reduce((sum, inv) => sum + inv.balance_due, 0)
      }
    });

    return reportData;
  }

  /**
   * Generate custom report
   */
  private async generateCustomReport(
    reportData: Partial<ReportData>,
    config: ReportConfig,
    business: any
  ): Promise<Partial<ReportData>> {
    // Custom report logic based on parameters
    return reportData;
  }

  /**
   * Export report to file
   */
  async exportReport(
    reportData: ReportData,
    format: 'pdf' | 'excel' | 'csv' | 'json'
  ): Promise<Buffer> {
    switch (format) {
      case 'json':
        return Buffer.from(JSON.stringify(reportData, null, 2));
      case 'csv':
        return await this.exportToCSV(reportData);
      case 'excel':
        return await this.exportToExcel(reportData);
      case 'pdf':
        return await this.exportToPDF(reportData);
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Export to CSV
   */
  private async exportToCSV(reportData: ReportData): Promise<Buffer> {
    const lines: string[] = [];

    // Header
    lines.push(`Report: ${reportData.metadata.businessName}`);
    lines.push(`Generated: ${format(reportData.metadata.generatedAt, 'yyyy-MM-dd HH:mm')}`);
    lines.push(`Period: ${format(reportData.metadata.period.from, 'yyyy-MM-dd')} to ${format(reportData.metadata.period.to, 'yyyy-MM-dd')}`);
    lines.push('');

    // Summary
    if (reportData.summary) {
      lines.push('Summary');
      Object.entries(reportData.summary).forEach(([key, value]) => {
        lines.push(`${key},${value}`);
      });
      lines.push('');
    }

    // Tables
    if (reportData.tables) {
      for (const table of reportData.tables) {
        lines.push(table.title);
        lines.push(table.headers.join(','));
        table.rows.forEach(row => {
          lines.push(row.join(','));
        });
        lines.push('');
      }
    }

    return Buffer.from(lines.join('\n'));
  }

  /**
   * Export to Excel
   */
  private async exportToExcel(reportData: ReportData): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    
    // Summary sheet
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.addRow(['Report', reportData.metadata.businessName]);
    summarySheet.addRow(['Generated', format(reportData.metadata.generatedAt, 'yyyy-MM-dd HH:mm')]);
    summarySheet.addRow(['Period', `${format(reportData.metadata.period.from, 'yyyy-MM-dd')} to ${format(reportData.metadata.period.to, 'yyyy-MM-dd')}`]);
    summarySheet.addRow([]);

    if (reportData.summary) {
      summarySheet.addRow(['Metric', 'Value']);
      Object.entries(reportData.summary).forEach(([key, value]) => {
        summarySheet.addRow([key, value]);
      });
    }

    // Data sheets
    if (reportData.tables) {
      for (const table of reportData.tables) {
        const sheet = workbook.addWorksheet(table.title.substring(0, 31));
        sheet.addRow(table.headers);
        table.rows.forEach(row => {
          sheet.addRow(row);
        });
        
        // Style header row
        sheet.getRow(1).font = { bold: true };
        sheet.getRow(1).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE0E0E0' }
        };
      }
    }

    // Charts sheet (simplified - would need more complex implementation)
    if (reportData.charts) {
      const chartsSheet = workbook.addWorksheet('Charts');
      chartsSheet.addRow(['Chart data is available in the JSON export']);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  /**
   * Export to PDF
   */
  private async exportToPDF(reportData: ReportData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const doc = new PDFKit({ margin: 50 });

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Title
      doc.fontSize(20).text(reportData.metadata.businessName, { align: 'center' });
      doc.moveDown();
      doc.fontSize(16).text('Financial Report', { align: 'center' });
      doc.moveDown();
      
      // Metadata
      doc.fontSize(10).text(`Generated: ${format(reportData.metadata.generatedAt, 'yyyy-MM-dd HH:mm')}`);
      doc.text(`Period: ${format(reportData.metadata.period.from, 'yyyy-MM-dd')} to ${format(reportData.metadata.period.to, 'yyyy-MM-dd')}`);
      doc.moveDown();

      // Summary
      if (reportData.summary) {
        doc.fontSize(14).text('Summary');
        doc.moveDown(0.5);
        
        Object.entries(reportData.summary).forEach(([key, value]) => {
          doc.fontSize(10).text(`${key}: ${value}`);
        });
        doc.moveDown();
      }

      // Tables
      if (reportData.tables) {
        for (const table of reportData.tables) {
          doc.fontSize(12).text(table.title);
          doc.moveDown(0.5);
          
          // Simple table representation
          table.rows.slice(0, 20).forEach(row => {
            doc.fontSize(8).text(row.join(' | '));
          });
          
          if (table.rows.length > 20) {
            doc.text(`... and ${table.rows.length - 20} more rows`);
          }
          
          doc.moveDown();
        }
      }

      doc.end();
    });
  }

  /**
   * Schedule report
   */
  async scheduleReport(config: ReportConfig): Promise<void> {
    if (!config.schedule) {
      throw new Error('Schedule configuration required');
    }

    await reportModel.create({
      business_id: config.businessId,
      name: config.name,
      type: config.type,
      format: config.format,
      is_scheduled: true,
      schedule_config: config.schedule,
      parameters: config.parameters,
      status: 'pending'
    });

    logger.info('Report scheduled', {
      businessId: config.businessId,
      reportName: config.name,
      schedule: config.schedule
    });
  }

  /**
   * Aggregate by month
   */
  private aggregateByMonth(data: any[], field: string): Array<{ month: string; total: number }> {
    const monthMap = new Map<string, number>();

    data.forEach(item => {
      const month = format(new Date(item.issue_date), 'yyyy-MM');
      const current = monthMap.get(month) || 0;
      monthMap.set(month, current + (item[field] || 0));
    });

    return Array.from(monthMap.entries())
      .map(([month, total]) => ({ month, total }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  /**
   * Aggregate payment methods
   */
  private aggregatePaymentMethods(transactions: any[]): Array<{
    method: string;
    count: number;
    amount: number;
    percentage: number;
  }> {
    const methodMap = new Map<string, { count: number; amount: number }>();
    let total = 0;

    transactions.forEach(t => {
      const method = t.payment_method || 'unknown';
      const current = methodMap.get(method) || { count: 0, amount: 0 };
      current.count++;
      current.amount += t.amount;
      methodMap.set(method, current);
      total += t.amount;
    });

    return Array.from(methodMap.entries())
      .map(([method, data]) => ({
        method,
        count: data.count,
        amount: data.amount,
        percentage: total > 0 ? (data.amount / total) * 100 : 0
      }))
      .sort((a, b) => b.amount - a.amount);
  }

  /**
   * Calculate filing due date (21st of following month)
   */
  private calculateFilingDueDate(date: Date): Date {
    const dueDate = new Date(date);
    dueDate.setMonth(dueDate.getMonth() + 1);
    dueDate.setDate(21);
    return dueDate;
  }

  /**
   * Extract summary from report data
   */
  private extractSummary(reportData: Partial<ReportData>): Record<string, any> {
    const summary: Record<string, any> = {};

    reportData.sections?.forEach(section => {
      if (section.type === 'metrics') {
        Object.assign(summary, section.data);
      }
    });

    return summary;
  }
}

export const reportGeneratorService = new ReportGeneratorService();

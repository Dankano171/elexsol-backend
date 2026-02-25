import nodemailer from 'nodemailer';
import { logger } from '../../../config/logger';
import { redis } from '../../../config/redis';
import { emailTemplates } from '../templates/EmailTemplates';

export interface EmailOptions {
  to: string | string[];
  from?: string;
  subject: string;
  template?: string;
  data?: Record<string, any>;
  html?: string;
  text?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
}

export interface EmailResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

export class EmailChannel {
  private transporter: nodemailer.Transporter;
  private readonly defaultFrom = process.env.EMAIL_FROM || 'noreply@elexsol.com';
  private readonly rateLimit = 100; // emails per minute
  private readonly rateLimitKey = 'email:ratelimit';

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT || '587'),
      secure: process.env.EMAIL_SECURE === 'true',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100
    });
  }

  /**
   * Send email
   */
  async send(options: EmailOptions): Promise<EmailResult> {
    try {
      // Check rate limit
      await this.checkRateLimit();

      // Prepare email content
      const html = await this.prepareContent(options);
      const text = options.text || this.stripHtml(html);

      // Send email
      const result = await this.transporter.sendMail({
        from: options.from || this.defaultFrom,
        to: options.to,
        cc: options.cc,
        bcc: options.bcc,
        replyTo: options.replyTo,
        subject: options.subject,
        html,
        text,
        attachments: options.attachments
      });

      logger.info('Email sent successfully', {
        messageId: result.messageId,
        to: options.to
      });

      return {
        messageId: result.messageId,
        accepted: result.accepted || [],
        rejected: result.rejected || [],
        response: result.response
      };
    } catch (error) {
      logger.error('Error sending email:', error);
      throw error;
    }
  }

  /**
   * Send notification
   */
  async sendNotification(data: {
    userId?: string;
    businessId: string;
    title: string;
    body: string;
    data?: Record<string, any>;
    preferences: any;
  }): Promise<void> {
    // Get user email
    const email = await this.getUserEmail(data.userId, data.businessId);
    
    if (!email) {
      logger.warn('No email address found for notification', data);
      return;
    }

    // Determine template based on notification type
    const template = this.getTemplateForNotification(data.title, data.data);

    await this.send({
      to: email,
      subject: data.title,
      template,
      data: {
        title: data.title,
        body: data.body,
        ...data.data
      }
    });
  }

  /**
   * Send batch emails
   */
  async sendBatch(emails: EmailOptions[]): Promise<EmailResult[]> {
    const results = await Promise.allSettled(
      emails.map(email => this.send(email))
    );

    return results
      .filter((r): r is PromiseFulfilledResult<EmailResult> => r.status === 'fulfilled')
      .map(r => r.value);
  }

  /**
   * Prepare email content (template or HTML)
   */
  private async prepareContent(options: EmailOptions): Promise<string> {
    if (options.html) {
      return options.html;
    }

    if (options.template && emailTemplates[options.template]) {
      return emailTemplates[options.template](options.data || {});
    }

    // Fallback to basic HTML
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${options.subject}</title>
        </head>
        <body>
          ${options.data?.body || options.text || ''}
        </body>
      </html>
    `;
  }

  /**
   * Strip HTML tags for plain text version
   */
  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Get user email
   */
  private async getUserEmail(userId?: string, businessId?: string): Promise<string | null> {
    if (userId) {
      const user = await userRepository.findById(userId);
      return user?.email || null;
    }

    if (businessId) {
      const business = await businessRepository.findById(businessId);
      return business?.email || null;
    }

    return null;
  }

  /**
   * Get template for notification
   */
  private getTemplateForNotification(title: string, data?: any): string {
    if (data?.type === 'invoice') {
      return 'invoice-notification';
    }
    if (title.includes('Action Required')) {
      return 'action-required';
    }
    if (title.includes('Digest')) {
      return 'daily-digest';
    }
    return 'default';
  }

  /**
   * Check rate limit
   */
  private async checkRateLimit(): Promise<void> {
    const current = await redis.incr(this.rateLimitKey);
    
    if (current === 1) {
      await redis.expire(this.rateLimitKey, 60); // 1 minute window
    }

    if (current > this.rateLimit) {
      throw new Error('Email rate limit exceeded');
    }
  }

  /**
   * Verify connection
   */
  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      logger.error('Email transporter verification failed:', error);
      return false;
    }
  }

  /**
   * Send test email
   */
  async sendTest(to: string): Promise<void> {
    await this.send({
      to,
      subject: 'Test Email from Elexsol',
      template: 'test',
      data: {
        message: 'This is a test email to verify your email configuration.'
      }
    });
  }
}

export const emailChannel = new EmailChannel();

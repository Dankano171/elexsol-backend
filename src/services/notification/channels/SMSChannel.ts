import twilio from 'twilio';
import { logger } from '../../../config/logger';
import { redis } from '../../../config/redis';
import { userRepository } from '../../../repositories/UserRepository';

export interface SMSOptions {
  to: string;
  from?: string;
  body: string;
  mediaUrl?: string[];
  statusCallback?: string;
}

export interface SMSResult {
  sid: string;
  status: string;
  to: string;
  from: string;
  body: string;
  errorCode?: number;
  errorMessage?: string;
}

export class SMSChannel {
  private client: twilio.Twilio;
  private readonly defaultFrom = process.env.TWILIO_PHONE_NUMBER;
  private readonly rateLimit = 20; // SMS per minute
  private readonly rateLimitKey = 'sms:ratelimit';
  private readonly dailyLimit = 500; // SMS per day
  private readonly dailyLimitKey = 'sms:daily';

  constructor() {
    this.client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }

  /**
   * Send SMS
   */
  async send(options: SMSOptions): Promise<SMSResult> {
    try {
      // Check rate limits
      await this.checkRateLimits(options.to);

      // Format phone number
      const to = this.formatPhoneNumber(options.to);

      // Send SMS
      const message = await this.client.messages.create({
        to,
        from: options.from || this.defaultFrom,
        body: options.body,
        mediaUrl: options.mediaUrl,
        statusCallback: options.statusCallback
      });

      logger.info('SMS sent successfully', {
        sid: message.sid,
        to: options.to,
        status: message.status
      });

      return {
        sid: message.sid,
        status: message.status,
        to: message.to,
        from: message.from,
        body: message.body,
        errorCode: message.errorCode,
        errorMessage: message.errorMessage
      };
    } catch (error) {
      logger.error('Error sending SMS:', error);
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
    // Get user phone
    const phone = await this.getUserPhone(data.userId, data.businessId);
    
    if (!phone) {
      logger.warn('No phone number found for SMS notification', data);
      return;
    }

    // Truncate body for SMS
    const smsBody = this.truncateBody(`${data.title}: ${data.body}`);

    await this.send({
      to: phone,
      body: smsBody
    });
  }

  /**
   * Send bulk SMS
   */
  async sendBulk(messages: SMSOptions[]): Promise<SMSResult[]> {
    const results = await Promise.allSettled(
      messages.map(msg => this.send(msg))
    );

    return results
      .filter((r): r is PromiseFulfilledResult<SMSResult> => r.status === 'fulfilled')
      .map(r => r.value);
  }

  /**
   * Send template SMS
   */
  async sendTemplate(
    to: string,
    template: string,
    params: Record<string, string>
  ): Promise<SMSResult> {
    const templates: Record<string, string> = {
      'verification': 'Your verification code is: {{code}}',
      'invoice-reminder': 'Invoice {{invoiceNumber}} of ₦{{amount}} is due on {{dueDate}}',
      'payment-received': 'Payment of ₦{{amount}} received for invoice {{invoiceNumber}}',
      'action-required': 'Action required: {{message}}'
    };

    let body = templates[template] || template;
    
    // Replace parameters
    Object.entries(params).forEach(([key, value]) => {
      body = body.replace(`{{${key}}}`, value);
    });

    return this.send({ to, body });
  }

  /**
   * Check rate limits
   */
  private async checkRateLimits(to: string): Promise<void> {
    // Per minute rate limit
    const minuteKey = `${this.rateLimitKey}:${to}`;
    const minuteCount = await redis.incr(minuteKey);
    
    if (minuteCount === 1) {
      await redis.expire(minuteKey, 60);
    }

    if (minuteCount > this.rateLimit) {
      throw new Error('SMS rate limit exceeded for this number');
    }

    // Daily rate limit
    const dayKey = `${this.dailyLimitKey}:${to}`;
    const dayCount = await redis.incr(dayKey);
    
    if (dayCount === 1) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      const secondsUntilTomorrow = Math.ceil((tomorrow.getTime() - Date.now()) / 1000);
      await redis.expire(dayKey, secondsUntilTomorrow);
    }

    if (dayCount > this.dailyLimit) {
      throw new Error('Daily SMS limit exceeded for this number');
    }
  }

  /**
   * Format phone number to E.164
   */
  private formatPhoneNumber(phone: string): string {
    // Remove all non-numeric characters
    const cleaned = phone.replace(/\D/g, '');
    
    // Nigerian numbers: add +234 prefix if missing
    if (cleaned.startsWith('0')) {
      return `+234${cleaned.substring(1)}`;
    }
    
    // Already has country code
    if (cleaned.startsWith('234')) {
      return `+${cleaned}`;
    }
    
    // Assume Nigerian number
    return `+234${cleaned}`;
  }

  /**
   * Get user phone number
   */
  private async getUserPhone(userId?: string, businessId?: string): Promise<string | null> {
    if (userId) {
      const user = await userRepository.findById(userId);
      return user?.phone || null;
    }

    if (businessId) {
      const business = await businessRepository.findById(businessId);
      return business?.phone || null;
    }

    return null;
  }

  /**
   * Truncate SMS body (160 characters for single SMS)
   */
  private truncateBody(body: string, maxLength: number = 160): string {
    if (body.length <= maxLength) {
      return body;
    }
    return body.substring(0, maxLength - 3) + '...';
  }

  /**
   * Check message length (SMS segments)
   */
  getMessageSegments(body: string): number {
    // GSM 7-bit encoding: 160 chars per segment
    // Unicode: 70 chars per segment
    const isUnicode = /[^\u0000-\u007F]/.test(body);
    const charsPerSegment = isUnicode ? 70 : 160;
    
    return Math.ceil(body.length / charsPerSegment);
  }

  /**
   * Get delivery status
   */
  async getDeliveryStatus(sid: string): Promise<string> {
    try {
      const message = await this.client.messages(sid).fetch();
      return message.status;
    } catch (error) {
      logger.error('Error fetching SMS status:', error);
      throw error;
    }
  }
}

export const smsChannel = new SMSChannel();

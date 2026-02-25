import { logger } from '../../../config/logger';
import { redis } from '../../../config/redis';
import { userRepository } from '../../../repositories/UserRepository';
import axios from 'axios';

export interface WhatsAppOptions {
  to: string;
  template?: string;
  body?: string;
  components?: Array<{
    type: 'header' | 'body' | 'button' | 'footer';
    parameters: Array<{
      type: 'text' | 'image' | 'document' | 'button';
      text?: string;
      image?: { link: string };
      document?: { link: string; filename: string };
      button?: { sub_type: 'quick_reply' | 'url'; index: number; url?: string };
    }>;
  }>;
  mediaUrl?: string;
  caption?: string;
  interactive?: {
    type: 'list' | 'button';
    body: { text: string };
    action: any;
  };
  previewUrl?: boolean;
}

export interface WhatsAppResult {
  messageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  to: string;
  timestamp: string;
  error?: string;
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  status: 'approved' | 'pending' | 'rejected';
  category: 'transactional' | 'marketing' | 'otp';
  components: Array<{
    type: string;
    text?: string;
    format?: string;
    example?: any;
  }>;
}

export class WhatsAppChannel {
  private readonly apiVersion = 'v18.0';
  private readonly baseUrl = 'https://graph.facebook.com';
  private readonly accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  private readonly phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  private readonly businessId = process.env.WHATSAPP_BUSINESS_ID;
  
  private readonly rateLimit = 100; // messages per minute
  private readonly rateLimitKey = 'whatsapp:ratelimit';
  private readonly dailyLimit = 1000; // messages per day
  private readonly dailyLimitKey = 'whatsapp:daily';

  /**
   * Send WhatsApp message
   */
  async send(options: WhatsAppOptions): Promise<WhatsAppResult> {
    try {
      // Check rate limits
      await this.checkRateLimits(options.to);

      // Format phone number
      const to = this.formatPhoneNumber(options.to);

      let payload: any = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to
      };

      // Determine message type
      if (options.template) {
        // Template message (for business-initiated conversations)
        payload.type = 'template';
        payload.template = {
          name: options.template,
          language: {
            code: 'en'
          },
          components: options.components || []
        };
      } else if (options.interactive) {
        // Interactive message (lists, buttons)
        payload.type = 'interactive';
        payload.interactive = options.interactive;
      } else if (options.mediaUrl) {
        // Media message
        payload.type = 'document';
        payload.document = {
          link: options.mediaUrl,
          caption: options.caption
        };
      } else {
        // Text message
        payload.type = 'text';
        payload.text = {
          body: options.body,
          preview_url: options.previewUrl || false
        };
      }

      // Send to WhatsApp API
      const response = await axios.post(
        `${this.baseUrl}/${this.apiVersion}/${this.phoneNumberId}/messages`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      logger.info('WhatsApp message sent', {
        messageId: response.data.messages[0].id,
        to: options.to
      });

      return {
        messageId: response.data.messages[0].id,
        status: 'sent',
        to: options.to,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Error sending WhatsApp message:', error);
      
      return {
        messageId: '',
        status: 'failed',
        to: options.to,
        timestamp: new Date().toISOString(),
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Send notification (for notification service)
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
      logger.warn('No phone number found for WhatsApp notification', data);
      return;
    }

    // Check if user has opted into WhatsApp
    if (!data.preferences.whatsapp) {
      return;
    }

    // Determine template based on notification type
    const template = this.getTemplateForNotification(data.title, data.data);

    if (template) {
      // Use template for business-initiated messages
      await this.send({
        to: phone,
        template,
        components: this.buildTemplateComponents(data)
      });
    } else {
      // Fallback to text message (only works for 24-hour conversation window)
      await this.send({
        to: phone,
        body: `${data.title}\n\n${data.body}`
      });
    }
  }

  /**
   * Send template message
   */
  async sendTemplate(
    to: string,
    templateName: string,
    language: string = 'en',
    components: WhatsAppOptions['components'] = []
  ): Promise<WhatsAppResult> {
    return this.send({
      to,
      template: templateName,
      components
    });
  }

  /**
   * Send interactive list message
   */
  async sendList(
    to: string,
    body: string,
    buttonText: string,
    sections: Array<{
      title: string;
      rows: Array<{
        id: string;
        title: string;
        description?: string;
      }>;
    }>
  ): Promise<WhatsAppResult> {
    return this.send({
      to,
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: buttonText,
          sections
        }
      }
    });
  }

  /**
   * Send interactive button message
   */
  async sendButtons(
    to: string,
    body: string,
    buttons: Array<{
      type: 'reply' | 'url';
      title: string;
      id?: string;
      url?: string;
    }>
  ): Promise<WhatsAppResult> {
    const actionButtons = buttons.map(btn => {
      if (btn.type === 'reply') {
        return {
          type: 'reply',
          reply: {
            id: btn.id || `btn-${Date.now()}`,
            title: btn.title
          }
        };
      } else {
        return {
          type: 'url',
          url: btn.url
        };
      }
    });

    return this.send({
      to,
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: actionButtons
        }
      }
    });
  }

  /**
   * Send document
   */
  async sendDocument(
    to: string,
    documentUrl: string,
    filename: string,
    caption?: string
  ): Promise<WhatsAppResult> {
    return this.send({
      to,
      mediaUrl: documentUrl,
      caption
    });
  }

  /**
   * Send image
   */
  async sendImage(
    to: string,
    imageUrl: string,
    caption?: string
  ): Promise<WhatsAppResult> {
    return this.send({
      to,
      mediaUrl: imageUrl,
      caption
    });
  }

  /**
   * Get message templates
   */
  async getTemplates(): Promise<WhatsAppTemplate[]> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/${this.apiVersion}/${this.businessId}/message_templates`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`
          },
          params: {
            limit: 100
          }
        }
      );

      return response.data.data.map((template: any) => ({
        id: template.id,
        name: template.name,
        language: template.language,
        status: template.status,
        category: template.category,
        components: template.components
      }));
    } catch (error) {
      logger.error('Error fetching WhatsApp templates:', error);
      return [];
    }
  }

  /**
   * Create message template
   */
  async createTemplate(template: {
    name: string;
    language: string;
    category: 'TRANSACTIONAL' | 'MARKETING' | 'OTP';
    components: any[];
  }): Promise<WhatsAppTemplate> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/${this.apiVersion}/${this.businessId}/message_templates`,
        {
          name: template.name,
          language: template.language,
          category: template.category,
          components: template.components
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        id: response.data.id,
        name: response.data.name,
        language: response.data.language,
        status: response.data.status,
        category: response.data.category,
        components: response.data.components
      };
    } catch (error) {
      logger.error('Error creating WhatsApp template:', error);
      throw error;
    }
  }

  /**
   * Delete template
   */
  async deleteTemplate(templateName: string): Promise<boolean> {
    try {
      await axios.delete(
        `${this.baseUrl}/${this.apiVersion}/${this.businessId}/message_templates`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`
          },
          params: {
            name: templateName
          }
        }
      );

      logger.info('WhatsApp template deleted', { templateName });
      return true;
    } catch (error) {
      logger.error('Error deleting WhatsApp template:', error);
      return false;
    }
  }

  /**
   * Mark message as read
   */
  async markAsRead(messageId: string): Promise<void> {
    try {
      await axios.post(
        `${this.baseUrl}/${this.apiVersion}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (error) {
      logger.error('Error marking WhatsApp message as read:', error);
    }
  }

  /**
   * Get message status
   */
  async getMessageStatus(messageId: string): Promise<string> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/${this.apiVersion}/${messageId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`
          }
        }
      );

      return response.data.status;
    } catch (error) {
      logger.error('Error getting message status:', error);
      return 'unknown';
    }
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
      throw new Error('WhatsApp rate limit exceeded for this number');
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
      throw new Error('Daily WhatsApp limit exceeded for this number');
    }
  }

  /**
   * Format phone number to international format
   */
  private formatPhoneNumber(phone: string): string {
    // Remove all non-numeric characters
    const cleaned = phone.replace(/\D/g, '');
    
    // Nigerian numbers: add 234 prefix if missing
    if (cleaned.startsWith('0')) {
      return `234${cleaned.substring(1)}`;
    }
    
    // Already has country code
    return cleaned;
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
   * Get template for notification type
   */
  private getTemplateForNotification(title: string, data?: any): string | null {
    if (data?.type === 'invoice_reminder') {
      return 'invoice_reminder';
    }
    if (data?.type === 'payment_received') {
      return 'payment_received';
    }
    if (title.includes('Action Required')) {
      return 'action_required';
    }
    if (title.includes('Verification')) {
      return 'verification_code';
    }
    if (title.includes('Welcome')) {
      return 'welcome_message';
    }
    return null;
  }

  /**
   * Build template components from notification data
   */
  private buildTemplateComponents(data: any): WhatsAppOptions['components'] {
    const components: WhatsAppOptions['components'] = [];

    // Header component (if needed)
    if (data.data?.header) {
      components.push({
        type: 'header',
        parameters: [{
          type: 'text',
          text: data.data.header
        }]
      });
    }

    // Body component with parameters
    if (data.data?.params) {
      components.push({
        type: 'body',
        parameters: data.data.params.map((param: string) => ({
          type: 'text',
          text: param
        }))
      });
    }

    // Button components
    if (data.data?.buttons) {
      data.data.buttons.forEach((button: any, index: number) => {
        components.push({
          type: 'button',
          parameters: [{
            type: 'button',
            button: {
              sub_type: button.type === 'url' ? 'url' : 'quick_reply',
              index,
              url: button.url
            }
          }]
        });
      });
    }

    return components;
  }

  /**
   * Verify webhook
   */
  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    
    if (mode === 'subscribe' && token === verifyToken) {
      return challenge;
    }
    
    return null;
  }

  /**
   * Handle incoming webhook
   */
  async handleWebhook(payload: any): Promise<void> {
    try {
      const entry = payload.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      if (value?.messages) {
        for (const message of value.messages) {
          await this.processIncomingMessage(message, value.contacts?.[0]);
        }
      }

      if (value?.statuses) {
        for (const status of value.statuses) {
          await this.processStatusUpdate(status);
        }
      }
    } catch (error) {
      logger.error('Error handling WhatsApp webhook:', error);
    }
  }

  /**
   * Process incoming message
   */
  private async processIncomingMessage(message: any, contact: any): Promise<void> {
    logger.info('Received WhatsApp message', {
      from: message.from,
      type: message.type,
      id: message.id
    });

    // Store in Redis for processing
    const key = `whatsapp:message:${message.id}`;
    await redis.setex(key, 86400, JSON.stringify({
      message,
      contact,
      receivedAt: new Date().toISOString()
    }));

    // Emit event for processing (would be picked up by a worker)
    // This is a placeholder - implement based on your needs
  }

  /**
   * Process status update
   */
  private async processStatusUpdate(status: any): Promise<void> {
    logger.info('WhatsApp message status update', {
      messageId: status.id,
      status: status.status,
      timestamp: status.timestamp
    });

    // Update message status in database
    const key = `whatsapp:message:${status.id}`;
    const message = await redis.get(key);
    
    if (message) {
      const data = JSON.parse(message);
      data.status = status.status;
      data.statusUpdatedAt = new Date().toISOString();
      await redis.setex(key, 86400, JSON.stringify(data));
    }
  }
}

export const whatsappChannel = new WhatsAppChannel();

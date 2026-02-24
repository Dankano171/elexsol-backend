import axios from 'axios';
import { logger } from '../../../config/logger';

export interface WhatsAppTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface WhatsAppBusinessProfile {
  id: string;
  name: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating: string;
  code_verification_status: string;
}

export interface WhatsAppMessage {
  id: string;
  from: string;
  to: string;
  timestamp: string;
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'contacts';
  text?: {
    body: string;
  };
  status: 'sent' | 'delivered' | 'read' | 'failed';
}

export class WhatsAppProvider {
  private readonly apiVersion = 'v18.0';
  private readonly baseUrl = 'https://graph.facebook.com';

  /**
   * Test connection
   */
  async testConnection(accessToken: string): Promise<{
    success: boolean;
    accountId?: string;
    error?: string;
  }> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/${this.apiVersion}/me`,
        {
          params: {
            access_token: accessToken,
            fields: 'id,name,phone_numbers',
          },
        }
      );

      if (response.data.id) {
        return {
          success: true,
          accountId: response.data.id,
        };
      }

      return {
        success: false,
        error: 'Unable to fetch WhatsApp Business account',
      };
    } catch (error) {
      logger.error('WhatsApp connection test failed:', error);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message,
      };
    }
  }

  /**
   * Get long-lived access token
   */
  async getLongLivedToken(shortLivedToken: string): Promise<WhatsAppTokenResponse> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/oauth/access_token`,
        {
          params: {
            grant_type: 'fb_exchange_token',
            client_id: process.env.WHATSAPP_APP_ID,
            client_secret: process.env.WHATSAPP_APP_SECRET,
            fb_exchange_token: shortLivedToken,
          },
        }
      );

      return response.data;
    } catch (error) {
      logger.error('WhatsApp token exchange failed:', error);
      throw new Error(`Failed to get long-lived token: ${error.message}`);
    }
  }

  /**
   * Refresh token (WhatsApp tokens don't typically need refresh)
   */
  async refreshToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt: Date;
  }> {
    // WhatsApp tokens are long-lived (60 days) and can't be refreshed
    // They need to be regenerated
    throw new Error('WhatsApp tokens cannot be refreshed. Please reconnect.');
  }

  /**
   * Sync data from WhatsApp
   */
  async sync(accessToken: string, settings: any): Promise<{
    success: boolean;
    recordsSynced: number;
    errors?: string[];
    warnings?: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];
    let recordsSynced = 0;

    try {
      // Get business profile
      const profile = await this.getBusinessProfile(accessToken);
      
      if (profile) {
        recordsSynced++;
      }

      // Get phone numbers
      const phoneNumbers = await this.getPhoneNumbers(accessToken);
      recordsSynced += phoneNumbers.length;

      // Get recent messages if needed
      if (settings.syncMessages) {
        const messages = await this.getRecentMessages(accessToken, settings.phoneNumberId);
        recordsSynced += messages.length;
      }

      return {
        success: true,
        recordsSynced,
        errors: errors.length ? errors : undefined,
        warnings: warnings.length ? warnings : undefined,
      };
    } catch (error) {
      logger.error('WhatsApp sync failed:', error);
      errors.push(error.message);
      return {
        success: false,
        recordsSynced,
        errors,
      };
    }
  }

  /**
   * Get business profile
   */
  async getBusinessProfile(accessToken: string): Promise<WhatsAppBusinessProfile | null> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/${this.apiVersion}/me`,
        {
          params: {
            access_token: accessToken,
            fields: 'id,name,phone_numbers{display_phone_number,verified_name,quality_rating,code_verification_status}',
          },
        }
      );

      return response.data;
    } catch (error) {
      logger.error('Failed to fetch WhatsApp business profile:', error);
      return null;
    }
  }

  /**
   * Get phone numbers
   */
  async getPhoneNumbers(accessToken: string): Promise<any[]> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/${this.apiVersion}/me/phone_numbers`,
        {
          params: {
            access_token: accessToken,
          },
        }
      );

      return response.data.data || [];
    } catch (error) {
      logger.error('Failed to fetch WhatsApp phone numbers:', error);
      return [];
    }
  }

  /**
   * Get recent messages
   */
  async getRecentMessages(
    accessToken: string,
    phoneNumberId: string,
    limit: number = 100
  ): Promise<WhatsAppMessage[]> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/${this.apiVersion}/${phoneNumberId}/messages`,
        {
          params: {
            access_token: accessToken,
            limit,
            fields: 'id,from,to,timestamp,type,text,status',
          },
        }
      );

      return response.data.data || [];
    } catch (error) {
      logger.error('Failed to fetch WhatsApp messages:', error);
      return [];
    }
  }

  /**
   * Register webhook
   */
  async registerWebhook(
    accessToken: string,
    webhookUrl: string
  ): Promise<{
    webhookId: string;
    topics: string[];
  }> {
    try {
      // WhatsApp webhooks are configured in the app dashboard
      // This is just a verification endpoint
      return {
        webhookId: 'whatsapp-webhook',
        topics: ['messages', 'message_deliveries', 'message_reads'],
      };
    } catch (error) {
      logger.error('WhatsApp webhook registration failed:', error);
      throw error;
    }
  }

  /**
   * Unregister webhook
   */
  async unregisterWebhook(accessToken: string, webhookId: string): Promise<void> {
    // Webhook configuration is managed in app dashboard
    logger.info('WhatsApp webhook unregistration requested');
  }

  /**
   * Validate webhook signature
   */
  async validateWebhook(payload: any, headers: any): Promise<boolean> {
    const signature = headers['x-hub-signature-256'];
    
    if (!signature) {
      return false;
    }

    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', process.env.WHATSAPP_APP_SECRET!)
      .update(JSON.stringify(payload))
      .digest('hex');

    return signature === `sha256=${expectedSignature}`;
  }

  /**
   * Extract integration identifier from webhook
   */
  extractIdentifier(payload: any): string {
    // Extract phone number ID from webhook
    return payload?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
  }

  /**
   * Extract event type from webhook
   */
  extractEventType(payload: any): string {
    const change = payload?.entry?.[0]?.changes?.[0];
    
    if (change?.field === 'messages') {
      return change.value?.messages?.[0]?.type || 'message';
    }
    
    return change?.field || 'unknown';
  }

  /**
   * Send message
   */
  async sendMessage(
    accessToken: string,
    phoneNumberId: string,
    to: string,
    message: any
  ): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/${this.apiVersion}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          ...message,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return response.data;
    } catch (error) {
      logger.error('WhatsApp message send failed:', error);
      throw error;
    }
  }

  /**
   * Send template message
   */
  async sendTemplate(
    accessToken: string,
    phoneNumberId: string,
    to: string,
    templateName: string,
    language: string = 'en',
    components: any[] = []
  ): Promise<any> {
    return this.sendMessage(accessToken, phoneNumberId, to, {
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: language,
        },
        components,
      },
    });
  }

  /**
   * Mark message as read
   */
  async markAsRead(
    accessToken: string,
    phoneNumberId: string,
    messageId: string
  ): Promise<void> {
    try {
      await axios.post(
        `${this.baseUrl}/${this.apiVersion}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (error) {
      logger.error('WhatsApp mark as read failed:', error);
    }
  }

  /**
   * Get message templates
   */
  async getTemplates(accessToken: string, businessId: string): Promise<any[]> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/${this.apiVersion}/${businessId}/message_templates`,
        {
          params: {
            access_token: accessToken,
          },
        }
      );

      return response.data.data || [];
    } catch (error) {
      logger.error('Failed to fetch WhatsApp templates:', error);
      return [];
    }
  }

  /**
   * Create message template
   */
  async createTemplate(
    accessToken: string,
    businessId: string,
    templateData: any
  ): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/${this.apiVersion}/${businessId}/message_templates`,
        templateData,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return response.data;
    } catch (error) {
      logger.error('WhatsApp template creation failed:', error);
      throw error;
    }
  }

  /**
   * Get phone number details
   */
  async getPhoneNumberDetails(
    accessToken: string,
    phoneNumberId: string
  ): Promise<any> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/${this.apiVersion}/${phoneNumberId}`,
        {
          params: {
            access_token: accessToken,
            fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,profile',
          },
        }
      );

      return response.data;
    } catch (error) {
      logger.error('Failed to fetch phone number details:', error);
      return null;
    }
  }
}

export const whatsappProvider = new WhatsAppProvider();

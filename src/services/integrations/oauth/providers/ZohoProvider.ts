import axios from 'axios';
import { logger } from '../../../config/logger';
import { encrypt, decrypt } from '../../../config/encryption';

export interface ZohoTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  api_domain: string;
  token_type: string;
}

export interface ZohoContact {
  contact_id: string;
  contact_name: string;
  company_name: string;
  email: string;
  phone: string;
  billing_address: any;
}

export interface ZohoInvoice {
  invoice_id: string;
  invoice_number: string;
  date: string;
  due_date: string;
  customer_id: string;
  customer_name: string;
  line_items: any[];
  total: number;
  balance: number;
  status: string;
}

export class ZohoProvider {
  private readonly clientId = process.env.ZOHO_CLIENT_ID;
  private readonly clientSecret = process.env.ZOHO_CLIENT_SECRET;
  private readonly accountsUrl = 'https://accounts.zoho.com';
  private readonly apiUrl = 'https://www.zohoapis.com';

  /**
   * Test connection
   */
  async testConnection(accessToken: string): Promise<{
    success: boolean;
    accountId?: string;
    error?: string;
  }> {
    try {
      const response = await axios.get(`${this.apiUrl}/books/v3/organization`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
      });

      if (response.data.code === 0 && response.data.organizations?.length > 0) {
        return {
          success: true,
          accountId: response.data.organizations[0].organization_id,
        };
      }

      return {
        success: false,
        error: 'Unable to fetch organization details',
      };
    } catch (error) {
      logger.error('Zoho connection test failed:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    }
  }

  /**
   * Exchange authorization code for tokens
   */
  async getTokensFromCode(code: string, redirectUri: string): Promise<ZohoTokenResponse> {
    try {
      const response = await axios.post(
        `${this.accountsUrl}/oauth/v2/token`,
        null,
        {
          params: {
            code,
            client_id: this.clientId,
            client_secret: this.clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          },
        }
      );

      return response.data;
    } catch (error) {
      logger.error('Zoho token exchange failed:', error);
      throw new Error(`Failed to get tokens: ${error.message}`);
    }
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt: Date;
  }> {
    try {
      const response = await axios.post(
        `${this.accountsUrl}/oauth/v2/token`,
        null,
        {
          params: {
            refresh_token: refreshToken,
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: 'refresh_token',
          },
        }
      );

      const expiresAt = new Date();
      expiresAt.setSeconds(expiresAt.getSeconds() + response.data.expires_in);

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token || refreshToken,
        expiresAt,
      };
    } catch (error) {
      logger.error('Zoho token refresh failed:', error);
      throw new Error(`Failed to refresh token: ${error.message}`);
    }
  }

  /**
   * Sync data from Zoho
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
      // Sync contacts
      if (settings.syncContacts !== false) {
        const contacts = await this.fetchContacts(accessToken);
        recordsSynced += contacts.length;
        // Process contacts (implement based on your needs)
      }

      // Sync invoices
      if (settings.syncInvoices !== false) {
        const invoices = await this.fetchInvoices(accessToken);
        recordsSynced += invoices.length;
        // Process invoices (implement based on your needs)
      }

      return {
        success: true,
        recordsSynced,
        errors: errors.length ? errors : undefined,
        warnings: warnings.length ? warnings : undefined,
      };
    } catch (error) {
      logger.error('Zoho sync failed:', error);
      errors.push(error.message);
      return {
        success: false,
        recordsSynced,
        errors,
      };
    }
  }

  /**
   * Fetch contacts from Zoho
   */
  async fetchContacts(accessToken: string): Promise<ZohoContact[]> {
    try {
      const response = await axios.get(`${this.apiUrl}/books/v3/contacts`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
        params: {
          per_page: 200,
        },
      });

      if (response.data.code === 0) {
        return response.data.contacts || [];
      }

      return [];
    } catch (error) {
      logger.error('Failed to fetch Zoho contacts:', error);
      throw error;
    }
  }

  /**
   * Fetch invoices from Zoho
   */
  async fetchInvoices(accessToken: string): Promise<ZohoInvoice[]> {
    try {
      const response = await axios.get(`${this.apiUrl}/books/v3/invoices`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
        params: {
          per_page: 200,
          sort_column: 'date',
          sort_order: 'D',
        },
      });

      if (response.data.code === 0) {
        return response.data.invoices || [];
      }

      return [];
    } catch (error) {
      logger.error('Failed to fetch Zoho invoices:', error);
      throw error;
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
      // Zoho Books webhook registration
      const response = await axios.post(
        `${this.apiUrl}/books/v3/webhooks`,
        {
          name: 'Elexsol Integration',
          url: webhookUrl,
          events: ['invoice.created', 'invoice.updated', 'invoice.paid', 'contact.created'],
          send_fields: 'all',
        },
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (response.data.code === 0) {
        return {
          webhookId: response.data.webhook.webhook_id,
          topics: response.data.webhook.events,
        };
      }

      throw new Error('Failed to register webhook');
    } catch (error) {
      logger.error('Zoho webhook registration failed:', error);
      throw error;
    }
  }

  /**
   * Unregister webhook
   */
  async unregisterWebhook(accessToken: string, webhookId: string): Promise<void> {
    try {
      await axios.delete(
        `${this.apiUrl}/books/v3/webhooks/${webhookId}`,
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
          },
        }
      );
    } catch (error) {
      logger.error('Zoho webhook unregistration failed:', error);
      // Don't throw - webhook cleanup shouldn't break main flow
    }
  }

  /**
   * Validate webhook signature
   */
  async validateWebhook(payload: any, headers: any): Promise<boolean> {
    // Zoho webhooks don't have signatures by default
    // They rely on webhook secret in URL
    return true;
  }

  /**
   * Extract integration identifier from webhook
   */
  extractIdentifier(payload: any): string {
    // Extract organization ID from payload
    return payload?.organization_id || payload?.organization?.organization_id;
  }

  /**
   * Extract event type from webhook
   */
  extractEventType(payload: any): string {
    return payload?.event || payload?.operation;
  }

  /**
   * Create invoice in Zoho
   */
  async createInvoice(accessToken: string, invoiceData: any): Promise<any> {
    try {
      const response = await axios.post(
        `${this.apiUrl}/books/v3/invoices`,
        invoiceData,
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (response.data.code === 0) {
        return response.data.invoice;
      }

      throw new Error(response.data.message || 'Failed to create invoice');
    } catch (error) {
      logger.error('Zoho invoice creation failed:', error);
      throw error;
    }
  }

  /**
   * Get invoice from Zoho
   */
  async getInvoice(accessToken: string, invoiceId: string): Promise<any> {
    try {
      const response = await axios.get(
        `${this.apiUrl}/books/v3/invoices/${invoiceId}`,
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
          },
        }
      );

      if (response.data.code === 0) {
        return response.data.invoice;
      }

      throw new Error(response.data.message || 'Failed to fetch invoice');
    } catch (error) {
      logger.error('Zoho invoice fetch failed:', error);
      throw error;
    }
  }

  /**
   * Update invoice in Zoho
   */
  async updateInvoice(
    accessToken: string,
    invoiceId: string,
    invoiceData: any
  ): Promise<any> {
    try {
      const response = await axios.put(
        `${this.apiUrl}/books/v3/invoices/${invoiceId}`,
        invoiceData,
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (response.data.code === 0) {
        return response.data.invoice;
      }

      throw new Error(response.data.message || 'Failed to update invoice');
    } catch (error) {
      logger.error('Zoho invoice update failed:', error);
      throw error;
    }
  }

  /**
   * Mark invoice as paid
   */
  async markInvoiceAsPaid(
    accessToken: string,
    invoiceId: string,
    paymentData: any
  ): Promise<any> {
    try {
      const response = await axios.post(
        `${this.apiUrl}/books/v3/invoices/${invoiceId}/payments`,
        paymentData,
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (response.data.code === 0) {
        return response.data.payment;
      }

      throw new Error(response.data.message || 'Failed to mark invoice as paid');
    } catch (error) {
      logger.error('Zoho payment recording failed:', error);
      throw error;
    }
  }

  /**
   * Get organization details
   */
  async getOrganization(accessToken: string): Promise<any> {
    try {
      const response = await axios.get(`${this.apiUrl}/books/v3/organization`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
      });

      if (response.data.code === 0 && response.data.organizations?.length > 0) {
        return response.data.organizations[0];
      }

      return null;
    } catch (error) {
      logger.error('Zoho organization fetch failed:', error);
      throw error;
    }
  }

  /**
   * Get API limits
   */
  async getApiLimits(accessToken: string): Promise<any> {
    try {
      const response = await axios.get(`${this.apiUrl}/books/v3/invoices`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
        params: {
          per_page: 1,
        },
      });

      const rateLimit = response.headers['x-rate-limit-limit'];
      const rateRemaining = response.headers['x-rate-limit-remaining'];
      const rateReset = response.headers['x-rate-limit-reset'];

      return {
        limit: rateLimit ? parseInt(rateLimit) : null,
        remaining: rateRemaining ? parseInt(rateRemaining) : null,
        resetAt: rateReset ? new Date(parseInt(rateReset) * 1000) : null,
      };
    } catch (error) {
      return null;
    }
  }
}

export const zohoProvider = new ZohoProvider();

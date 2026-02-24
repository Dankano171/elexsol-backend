import axios from 'axios';
import { logger } from '../../../config/logger';
import qs from 'qs';

export interface QuickBooksTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
  token_type: string;
}

export interface QuickBooksCustomer {
  Id: string;
  DisplayName: string;
  GivenName?: string;
  FamilyName?: string;
  PrimaryEmailAddr?: {
    Address: string;
  };
  PrimaryPhone?: {
    FreeFormNumber: string;
  };
  BillAddr?: {
    Line1: string;
    City: string;
    CountrySubDivisionCode: string;
    PostalCode: string;
  };
}

export interface QuickBooksInvoice {
  Id: string;
  DocNumber: string;
  TxnDate: string;
  DueDate: string;
  CustomerRef: {
    value: string;
    name: string;
  };
  Line: any[];
  TotalAmt: number;
  Balance: number;
  EmailStatus: string;
}

export class QuickBooksProvider {
  private readonly clientId = process.env.QUICKBOOKS_CLIENT_ID;
  private readonly clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  private readonly environment = process.env.QUICKBOOKS_ENVIRONMENT || 'sandbox';
  private readonly baseUrl = this.environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
  private readonly accountsUrl = 'https://accounts.platform.intuit.com/v2';

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
        `${this.baseUrl}/v3/company/me/companyinfo/me`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        }
      );

      if (response.data.CompanyInfo) {
        return {
          success: true,
          accountId: response.data.CompanyInfo.CompanyId,
        };
      }

      return {
        success: false,
        error: 'Unable to fetch company information',
      };
    } catch (error) {
      logger.error('QuickBooks connection test failed:', error);
      return {
        success: false,
        error: error.response?.data?.fault?.error?.[0]?.message || error.message,
      };
    }
  }

  /**
   * Get tokens from authorization code
   */
  async getTokensFromCode(code: string, redirectUri: string): Promise<QuickBooksTokenResponse> {
    try {
      const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

      const response = await axios.post(
        `${this.accountsUrl}/oauth2/token`,
        qs.stringify({
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
        {
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      return response.data;
    } catch (error) {
      logger.error('QuickBooks token exchange failed:', error);
      throw new Error(`Failed to get tokens: ${error.message}`);
    }
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    refreshExpiresAt: Date;
  }> {
    try {
      const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

      const response = await axios.post(
        `${this.accountsUrl}/oauth2/token`,
        qs.stringify({
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
        {
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const expiresAt = new Date();
      expiresAt.setSeconds(expiresAt.getSeconds() + response.data.expires_in);

      const refreshExpiresAt = new Date();
      refreshExpiresAt.setSeconds(refreshExpiresAt.getSeconds() + response.data.x_refresh_token_expires_in);

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresAt,
        refreshExpiresAt,
      };
    } catch (error) {
      logger.error('QuickBooks token refresh failed:', error);
      throw new Error(`Failed to refresh token: ${error.message}`);
    }
  }

  /**
   * Sync data from QuickBooks
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
      // Sync customers
      if (settings.syncCustomers !== false) {
        const customers = await this.fetchCustomers(accessToken, settings.companyId);
        recordsSynced += customers.length;
        // Process customers (implement based on your needs)
      }

      // Sync invoices
      if (settings.syncInvoices !== false) {
        const invoices = await this.fetchInvoices(accessToken, settings.companyId);
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
      logger.error('QuickBooks sync failed:', error);
      errors.push(error.message);
      return {
        success: false,
        recordsSynced,
        errors,
      };
    }
  }

  /**
   * Fetch customers from QuickBooks
   */
  async fetchCustomers(accessToken: string, companyId: string): Promise<QuickBooksCustomer[]> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/v3/company/${companyId}/query`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/text',
          },
          params: {
            query: "SELECT * FROM Customer WHERE Active = true MAXRESULTS 1000",
          },
        }
      );

      return response.data.QueryResponse?.Customer || [];
    } catch (error) {
      logger.error('Failed to fetch QuickBooks customers:', error);
      throw error;
    }
  }

  /**
   * Fetch invoices from QuickBooks
   */
  async fetchInvoices(accessToken: string, companyId: string): Promise<QuickBooksInvoice[]> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/v3/company/${companyId}/query`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/text',
          },
          params: {
            query: "SELECT * FROM Invoice WHERE Balance > 0 MAXRESULTS 1000",
          },
        }
      );

      return response.data.QueryResponse?.Invoice || [];
    } catch (error) {
      logger.error('Failed to fetch QuickBooks invoices:', error);
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
      // QuickBooks webhooks are configured in the developer dashboard
      // This is just a verification endpoint
      return {
        webhookId: 'quickbooks-webhook',
        topics: ['Invoice', 'Customer', 'Payment'],
      };
    } catch (error) {
      logger.error('QuickBooks webhook registration failed:', error);
      throw error;
    }
  }

  /**
   * Unregister webhook
   */
  async unregisterWebhook(accessToken: string, webhookId: string): Promise<void> {
    // Webhook configuration is managed in developer dashboard
    logger.info('QuickBooks webhook unregistration requested');
  }

  /**
   * Validate webhook signature
   */
  async validateWebhook(payload: any, headers: any): Promise<boolean> {
    const signature = headers['intuit-signature'];
    
    if (!signature) {
      return false;
    }

    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', process.env.QUICKBOOKS_WEBHOOK_TOKEN!)
      .update(JSON.stringify(payload))
      .digest('base64');

    return signature === expectedSignature;
  }

  /**
   * Extract integration identifier from webhook
   */
  extractIdentifier(payload: any): string {
    // Extract realm ID from webhook
    return payload?.realmId || payload?.companyId;
  }

  /**
   * Extract event type from webhook
   */
  extractEventType(payload: any): string {
    const event = payload?.eventNotifications?.[0]?.dataChangeEvent?.entities?.[0];
    
    if (event) {
      return `${event.name}.${event.operation}`.toLowerCase();
    }
    
    return 'unknown';
  }

  /**
   * Create invoice in QuickBooks
   */
  async createInvoice(accessToken: string, companyId: string, invoiceData: any): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/v3/company/${companyId}/invoice`,
        invoiceData,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return response.data.Invoice;
    } catch (error) {
      logger.error('QuickBooks invoice creation failed:', error);
      throw error;
    }
  }

  /**
   * Get invoice from QuickBooks
   */
  async getInvoice(accessToken: string, companyId: string, invoiceId: string): Promise<any> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/v3/company/${companyId}/invoice/${invoiceId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      return response.data.Invoice;
    } catch (error) {
      logger.error('QuickBooks invoice fetch failed:', error);
      throw error;
    }
  }

  /**
   * Update invoice in QuickBooks
   */
  async updateInvoice(
    accessToken: string,
    companyId: string,
    invoiceId: string,
    invoiceData: any
  ): Promise<any> {
    try {
      // Get current invoice for sync token
      const current = await this.getInvoice(accessToken, companyId, invoiceId);
      
      invoiceData.SyncToken = current.SyncToken;
      invoiceData.Id = invoiceId;

      const response = await axios.post(
        `${this.baseUrl}/v3/company/${companyId}/invoice`,
        invoiceData,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return response.data.Invoice;
    } catch (error) {
      logger.error('QuickBooks invoice update failed:', error);
      throw error;
    }
  }

  /**
   * Create payment in QuickBooks
   */
  async createPayment(accessToken: string, companyId: string, paymentData: any): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/v3/company/${companyId}/payment`,
        paymentData,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return response.data.Payment;
    } catch (error) {
      logger.error('QuickBooks payment creation failed:', error);
      throw error;
    }
  }

  /**
   * Create customer in QuickBooks
   */
  async createCustomer(accessToken: string, companyId: string, customerData: any): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/v3/company/${companyId}/customer`,
        customerData,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return response.data.Customer;
    } catch (error) {
      logger.error('QuickBooks customer creation failed:', error);
      throw error;
    }
  }

  /**
   * Get company information
   */
  async getCompanyInfo(accessToken: string, companyId: string): Promise<any> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/v3/company/${companyId}/companyinfo/${companyId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      return response.data.CompanyInfo;
    } catch (error) {
      logger.error('QuickBooks company info fetch failed:', error);
      throw error;
    }
  }

  /**
   * Get API limits
   */
  async getApiLimits(accessToken: string): Promise<any> {
    // QuickBooks doesn't provide rate limit info in headers
    return null;
  }
}

export const quickbooksProvider = new QuickBooksProvider();

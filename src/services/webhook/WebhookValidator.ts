import { logger } from '../../config/logger';
import crypto from 'crypto';
import { URL } from 'url';

export interface ValidationRule {
  name: string;
  validate: (data: any) => boolean;
  errorMessage: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export class WebhookValidator {
  private readonly allowedIPs = new Set([
    // Zoho IP ranges
    '136.143.188.0/24',
    '165.225.72.0/24',
    // WhatsApp IP ranges
    '3.208.120.0/24',
    '18.208.120.0/24',
    // QuickBooks IP ranges
    '52.10.120.0/24',
    '54.148.160.0/24'
  ]);

  private readonly providers = {
    zoho: {
      signatureHeader: 'x-zoho-signature',
      timestampHeader: 'x-zoho-timestamp',
      validate: this.validateZohoSignature.bind(this)
    },
    whatsapp: {
      signatureHeader: 'x-hub-signature-256',
      validate: this.validateWhatsAppSignature.bind(this)
    },
    quickbooks: {
      signatureHeader: 'intuit-signature',
      validate: this.validateQuickBooksSignature.bind(this)
    }
  };

  /**
   * Validate webhook signature
   */
  async validateSignature(
    provider: string,
    headers: Record<string, any>,
    payload: any,
    secret: string
  ): Promise<boolean> {
    try {
      const providerConfig = this.providers[provider as keyof typeof this.providers];
      
      if (!providerConfig) {
        // Unknown provider - use generic validation
        return this.validateGenericSignature(headers, payload, secret);
      }

      return await providerConfig.validate(headers, payload, secret);
    } catch (error) {
      logger.error('Error validating webhook signature:', error);
      return false;
    }
  }

  /**
   * Validate Zoho signature
   */
  private async validateZohoSignature(
    headers: Record<string, any>,
    payload: any,
    secret: string
  ): Promise<boolean> {
    const signature = headers['x-zoho-signature'];
    const timestamp = headers['x-zoho-timestamp'];

    if (!signature || !timestamp) {
      return false;
    }

    // Check timestamp freshness (5 minutes)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 300) {
      return false;
    }

    const data = `${timestamp}.${JSON.stringify(payload)}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  /**
   * Validate WhatsApp signature
   */
  private async validateWhatsAppSignature(
    headers: Record<string, any>,
    payload: any,
    secret: string
  ): Promise<boolean> {
    const signature = headers['x-hub-signature-256'];
    
    if (!signature) {
      return false;
    }

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex');

    // WhatsApp signatures are prefixed with 'sha256='
    const providedSignature = signature.replace('sha256=', '');

    return crypto.timingSafeEqual(
      Buffer.from(providedSignature),
      Buffer.from(expectedSignature)
    );
  }

  /**
   * Validate QuickBooks signature
   */
  private async validateQuickBooksSignature(
    headers: Record<string, any>,
    payload: any,
    secret: string
  ): Promise<boolean> {
    const signature = headers['intuit-signature'];
    
    if (!signature) {
      return false;
    }

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('base64');

    return signature === expectedSignature;
  }

  /**
   * Validate generic signature
   */
  private validateGenericSignature(
    headers: Record<string, any>,
    payload: any,
    secret: string
  ): boolean {
    const signature = headers['x-webhook-signature'];
    const timestamp = headers['x-webhook-timestamp'];

    if (!signature) {
      return false;
    }

    let data = JSON.stringify(payload);
    
    if (timestamp) {
      // Check timestamp freshness
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - parseInt(timestamp)) > 300) {
        return false;
      }
      data = `${timestamp}.${data}`;
    }

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  /**
   * Validate webhook payload
   */
  validatePayload(provider: string, payload: any): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Provider-specific validation
    switch (provider) {
      case 'zoho':
        this.validateZohoPayload(payload, errors, warnings);
        break;
      case 'whatsapp':
        this.validateWhatsAppPayload(payload, errors, warnings);
        break;
      case 'quickbooks':
        this.validateQuickBooksPayload(payload, errors, warnings);
        break;
    }

    // Common validation
    if (!payload || typeof payload !== 'object') {
      errors.push('Payload must be an object');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate Zoho payload
   */
  private validateZohoPayload(payload: any, errors: string[], warnings: string[]): void {
    if (!payload.event) {
      errors.push('Missing event type');
    }

    if (!payload.organization_id) {
      warnings.push('Missing organization ID');
    }
  }

  /**
   * Validate WhatsApp payload
   */
  private validateWhatsAppPayload(payload: any, errors: string[], warnings: string[]): void {
    if (!payload.entry || !Array.isArray(payload.entry)) {
      errors.push('Invalid WhatsApp payload structure');
      return;
    }

    const entry = payload.entry[0];
    if (!entry?.changes || !Array.isArray(entry.changes)) {
      errors.push('Missing changes array');
    }
  }

  /**
   * Validate QuickBooks payload
   */
  private validateQuickBooksPayload(payload: any, errors: string[], warnings: string[]): void {
    if (!payload.eventNotifications || !Array.isArray(payload.eventNotifications)) {
      errors.push('Invalid QuickBooks payload structure');
    }

    if (!payload.realmId) {
      errors.push('Missing realm ID');
    }
  }

  /**
   * Validate webhook URL
   */
  validateWebhookUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      
      // Must be HTTPS
      if (parsed.protocol !== 'https:') {
        return false;
      }

      // Check for localhost in production
      if (process.env.NODE_ENV === 'production') {
        if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate IP address
   */
  validateIP(ip: string): boolean {
    // Convert IP to number for range checking
    const ipNum = this.ipToNumber(ip);

    for (const range of this.allowedIPs) {
      if (this.isIPInRange(ipNum, range)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Convert IP to number
   */
  private ipToNumber(ip: string): number {
    return ip.split('.')
      .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
  }

  /**
   * Check if IP is in CIDR range
   */
  private isIPInRange(ip: number, range: string): boolean {
    const [base, bits] = range.split('/');
    const mask = ~((1 << (32 - parseInt(bits))) - 1);
    const baseNum = this.ipToNumber(base);

    return (ip & mask) === (baseNum & mask);
  }

  /**
   * Get validation rules for provider
   */
  getValidationRules(provider: string): ValidationRule[] {
    const commonRules: ValidationRule[] = [
      {
        name: 'required_fields',
        validate: (data) => data && typeof data === 'object',
        errorMessage: 'Payload must be an object'
      }
    ];

    const providerRules: Record<string, ValidationRule[]> = {
      zoho: [
        {
          name: 'has_event',
          validate: (data) => !!data.event,
          errorMessage: 'Missing event type'
        },
        {
          name: 'has_organization',
          validate: (data) => !!data.organization_id,
          errorMessage: 'Missing organization ID'
        }
      ],
      whatsapp: [
        {
          name: 'has_entry',
          validate: (data) => data.entry && Array.isArray(data.entry) && data.entry.length > 0,
          errorMessage: 'Invalid WhatsApp payload structure'
        }
      ],
      quickbooks: [
        {
          name: 'has_notifications',
          validate: (data) => data.eventNotifications && Array.isArray(data.eventNotifications),
          errorMessage: 'Missing event notifications'
        },
        {
          name: 'has_realm',
          validate: (data) => !!data.realmId,
          errorMessage: 'Missing realm ID'
        }
      ]
    };

    return [...commonRules, ...(providerRules[provider] || [])];
  }
}

export const webhookValidator = new WebhookValidator();

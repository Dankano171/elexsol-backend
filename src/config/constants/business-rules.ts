/**
 * Business rules and validation constants
 */

// VAT configuration
export const VAT_CONFIG = {
  RATE: 7.5, // Percentage
  EFFECTIVE_DATE: '2020-02-01', // When 7.5% came into effect
  EXEMPT_CATEGORIES: [
    'Exported goods',
    'Services exported',
    'Goods imported for diplomatic missions',
    'Services rendered by diplomats',
    'Non-resident companies',
    'Basic food items',
    'Medical services',
    'Educational services',
  ],
  ZERO_RATED_CATEGORIES: [
    'Exported goods',
    'Exported services',
    'Goods imported for diplomatic missions',
  ],
};

// Business size classification based on turnover (₦)
export const BUSINESS_SIZE = {
  MICRO: {
    min: 0,
    max: 25_000_000,
    description: 'Micro business (₦0 - ₦25M)',
    filingFrequency: 'annual',
  },
  SMALL: {
    min: 25_000_001,
    max: 100_000_000,
    description: 'Small business (₦25M - ₦100M)',
    filingFrequency: 'quarterly',
  },
  MEDIUM: {
    min: 100_000_001,
    max: 1_000_000_000,
    description: 'Medium business (₦100M - ₦1B)',
    filingFrequency: 'quarterly',
  },
  LARGE: {
    min: 1_000_000_001,
    max: Infinity,
    description: 'Large business (₦1B+)',
    filingFrequency: 'monthly',
  },
};

// Invoice status lifecycle
export const INVOICE_STATUS = {
  DRAFT: 'draft',
  VALIDATED: 'validated',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
} as const;

export type InvoiceStatus = typeof INVOICE_STATUS[keyof typeof INVOICE_STATUS];

export const INVOICE_STATUS_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  [INVOICE_STATUS.DRAFT]: [INVOICE_STATUS.VALIDATED, INVOICE_STATUS.CANCELLED],
  [INVOICE_STATUS.VALIDATED]: [INVOICE_STATUS.SUBMITTED, INVOICE_STATUS.DRAFT, INVOICE_STATUS.CANCELLED],
  [INVOICE_STATUS.SUBMITTED]: [INVOICE_STATUS.APPROVED, INVOICE_STATUS.REJECTED],
  [INVOICE_STATUS.APPROVED]: [INVOICE_STATUS.CANCELLED, INVOICE_STATUS.EXPIRED],
  [INVOICE_STATUS.REJECTED]: [INVOICE_STATUS.DRAFT, INVOICE_STATUS.CANCELLED],
  [INVOICE_STATUS.CANCELLED]: [],
  [INVOICE_STATUS.EXPIRED]: [],
};

// Payment status
export const PAYMENT_STATUS = {
  UNPAID: 'unpaid',
  PARTIAL: 'partial',
  PAID: 'paid',
  OVERDUE: 'overdue',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
} as const;

export type PaymentStatus = typeof PAYMENT_STATUS[keyof typeof PAYMENT_STATUS];

// Integration providers
export const INTEGRATION_PROVIDERS = {
  ZOHO: 'zoho',
  WHATSAPP: 'whatsapp',
  QUICKBOOKS: 'quickbooks',
} as const;

export type IntegrationProvider = typeof INTEGRATION_PROVIDERS[keyof typeof INTEGRATION_PROVIDERS];

export const PROVIDER_SCOPES: Record<IntegrationProvider, string[]> = {
  [INTEGRATION_PROVIDERS.ZOHO]: [
    'ZohoBooks.invoice.READ',
    'ZohoBooks.invoice.CREATE',
    'ZohoBooks.contact.READ',
    'ZohoBooks.contact.CREATE',
  ],
  [INTEGRATION_PROVIDERS.WHATSAPP]: [
    'whatsapp_business_messages',
    'whatsapp_business_profile',
    'whatsapp_business_phone_numbers',
  ],
  [INTEGRATION_PROVIDERS.QUICKBOOKS]: [
    'com.intuit.quickbooks.accounting',
    'com.intuit.quickbooks.payment',
    'openid',
    'profile',
    'email',
  ],
};

// Webhook event types
export const WEBHOOK_EVENTS = {
  INVOICE_CREATED: 'invoice.created',
  INVOICE_UPDATED: 'invoice.updated',
  INVOICE_PAID: 'invoice.paid',
  INVOICE_OVERDUE: 'invoice.overdue',
  INVOICE_CANCELLED: 'invoice.cancelled',
  PAYMENT_RECEIVED: 'payment.received',
  PAYMENT_FAILED: 'payment.failed',
  INTEGRATION_CONNECTED: 'integration.connected',
  INTEGRATION_DISCONNECTED: 'integration.disconnected',
  INTEGRATION_EXPIRED: 'integration.expired',
  INTEGRATION_ERROR: 'integration.error',
  REGULATORY_SUBMITTED: 'regulatory.submitted',
  REGULATORY_APPROVED: 'regulatory.approved',
  REGULATORY_REJECTED: 'regulatory.rejected',
  REGULATORY_FAILED: 'regulatory.failed',
} as const;

export type WebhookEvent = typeof WEBHOOK_EVENTS[keyof typeof WEBHOOK_EVENTS];

// Notification types
export const NOTIFICATION_TYPES = {
  SUCCESS: 'success',
  ACTION_REQUIRED: 'action_required',
  INTEGRATION: 'integration',
  REGULATORY: 'regulatory',
} as const;

export type NotificationType = typeof NOTIFICATION_TYPES[keyof typeof NOTIFICATION_TYPES];

// Notification priorities
export const NOTIFICATION_PRIORITIES = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;

export type NotificationPriority = typeof NOTIFICATION_PRIORITIES[keyof typeof NOTIFICATION_PRIORITIES];

// Notification channels
export const NOTIFICATION_CHANNELS = {
  EMAIL: 'email',
  SMS: 'sms',
  PUSH: 'push',
  INAPP: 'inapp',
  WHATSAPP: 'whatsapp',
} as const;

export type NotificationChannel = typeof NOTIFICATION_CHANNELS[keyof typeof NOTIFICATION_CHANNELS];

// Notification frequencies
export const NOTIFICATION_FREQUENCIES = {
  IMMEDIATE: 'immediate',
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
} as const;

export type NotificationFrequency = typeof NOTIFICATION_FREQUENCIES[keyof typeof NOTIFICATION_FREQUENCIES];

// Currency codes
export const CURRENCIES = {
  NGN: 'NGN',
  USD: 'USD',
  EUR: 'EUR',
  GBP: 'GBP',
} as const;

export type Currency = typeof CURRENCIES[keyof typeof CURRENCIES];

// Timezone for Nigeria
export const NIGERIA_TIMEZONE = 'Africa/Lagos';

// Date formats
export const DATE_FORMATS = {
  ISO: 'YYYY-MM-DDTHH:mm:ss.SSSZ',
  DISPLAY: 'DD MMM YYYY',
  DISPLAY_TIME: 'DD MMM YYYY HH:mm',
  FILENAME: 'YYYYMMDD_HHmmss',
  MONTH_YEAR: 'MMM YYYY',
  YEAR_MONTH: 'YYYY-MM',
} as const;

// Pagination defaults
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

// Rate limiting
export const RATE_LIMITS = {
  API: {
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
  },
  AUTH: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per 15 minutes
  },
  WEBHOOK: {
    windowMs: 60 * 1000, // 1 minute
    max: 1000, // 1000 webhooks per minute
  },
  FIRS: {
    windowMs: 60 * 1000, // 1 minute
    max: 50, // 50 submissions per minute
  },
} as const;

// Cache TTLs (in seconds)
export const CACHE_TTL = {
  BUSINESS: 3600, // 1 hour
  INTEGRATION: 300, // 5 minutes
  INVOICE: 600, // 10 minutes
  ANALYTICS: 3600, // 1 hour
  TOKEN: 900, // 15 minutes
  SESSION: 86400, // 24 hours
} as const;

// File upload limits
export const FILE_UPLOAD = {
  MAX_SIZE: 10 * 1024 * 1024, // 10MB
  ALLOWED_TYPES: ['image/jpeg', 'image/png', 'application/pdf'],
  MAX_FILES: 5,
} as const;

// Audit log actions
export const AUDIT_ACTIONS = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  VIEW: 'VIEW',
  EXPORT: 'EXPORT',
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  MFA_ENABLE: 'MFA_ENABLE',
  MFA_DISABLE: 'MFA_DISABLE',
  PASSWORD_CHANGE: 'PASSWORD_CHANGE',
  INTEGRATION_CONNECT: 'INTEGRATION_CONNECT',
  INTEGRATION_DISCONNECT: 'INTEGRATION_DISCONNECT',
  INTEGRATION_SYNC: 'INTEGRATION_SYNC',
  WEBHOOK_RECEIVED: 'WEBHOOK_RECEIVED',
  WEBHOOK_PROCESSED: 'WEBHOOK_PROCESSED',
  REGULATORY_SUBMIT: 'REGULATORY_SUBMIT',
  REGULATORY_APPROVE: 'REGULATORY_APPROVE',
  REGULATORY_REJECT: 'REGULATORY_REJECT',
  NOTIFICATION_SEND: 'NOTIFICATION_SEND',
} as const;

export type AuditAction = typeof AUDIT_ACTIONS[keyof typeof AUDIT_ACTIONS];

// Nigerian bank codes
export const NIGERIAN_BANKS = [
  { code: '044', name: 'Access Bank' },
  { code: '023', name: 'Citibank' },
  { code: '063', name: 'Diamond Bank' },
  { code: '050', name: 'Ecobank' },
  { code: '084', name: 'Enterprise Bank' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '030', name: 'Heritage Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '014', name: 'MainStreet Bank' },
  { code: '076', name: 'Skye Bank' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '068', name: 'Standard Chartered Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '032', name: 'Union Bank' },
  { code: '033', name: 'United Bank for Africa' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
] as const;

// API versions
export const API_VERSIONS = {
  V1: 'v1',
  V2: 'v2',
} as const;

export type ApiVersion = typeof API_VERSIONS[keyof typeof API_VERSIONS];

// Feature flags
export const FEATURES = {
  E_INVOICING: 'e-invoicing',
  GROWTH_ANALYTICS: 'growth-analytics',
  MULTI_CURRENCY: 'multi-currency',
  API_ACCESS: 'api-access',
  WHITE_LABEL: 'white-label',
  ADVANCED_REPORTING: 'advanced-reporting',
  CUSTOM_INTEGRATIONS: 'custom-integrations',
} as const;

export type Feature = typeof FEATURES[keyof typeof FEATURES];

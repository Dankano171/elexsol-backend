import { Request, Response, NextFunction } from 'express';

// Patterns for PII detection
const PII_PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone: /(\+?234|0)[7-9][0-1]\d{8}/g,
  tin: /\b\d{10}\b/g,
  cac: /\b(RC|BN|IT|LP|NC)\d{5,}\b/g,
  accountNumber: /\b\d{10}\b/g,
  creditCard: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
  ipAddress: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g
};

// Fields to mask by default
const SENSITIVE_FIELDS = [
  'password',
  'password_hash',
  'password_confirmation',
  'current_password',
  'new_password',
  'old_password',
  'token',
  'refresh_token',
  'access_token',
  'api_key',
  'secret',
  'client_secret',
  'mfa_secret',
  'mfa_backup_codes',
  'encrypted_access_token',
  'encrypted_refresh_token',
  'private_key',
  'certificate'
];

// Fields that contain PII
const PII_FIELDS = [
  'email',
  'phone',
  'mobile',
  'telephone',
  'whatsapp',
  'address',
  'street',
  'city',
  'state',
  'postal_code',
  'zip',
  'country',
  'ip_address',
  'ip',
  'user_agent',
  'browser',
  'device_id',
  'device_name',
  'location',
  'coordinates',
  'latitude',
  'longitude',
  'bank_account',
  'account_number',
  'routing_number',
  'sort_code',
  'iban',
  'swift',
  'bic',
  'credit_card',
  'card_number',
  'cvv',
  'cvc',
  'expiry',
  'expiration'
];

/**
 * Mask PII in objects
 */
const maskPII = (obj: any, depth: number = 0, maxDepth: number = 10): any => {
  if (depth > maxDepth) return obj;
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => maskPII(item, depth + 1, maxDepth));
  }

  const masked = { ...obj };

  for (const [key, value] of Object.entries(masked)) {
    // Mask sensitive fields completely
    if (SENSITIVE_FIELDS.includes(key.toLowerCase())) {
      masked[key] = '[REDACTED]';
      continue;
    }

    // Mask PII fields with partial masking
    if (PII_FIELDS.includes(key.toLowerCase()) && typeof value === 'string') {
      masked[key] = maskString(value, key);
      continue;
    }

    // Recursively process nested objects
    if (value && typeof value === 'object') {
      masked[key] = maskPII(value, depth + 1, maxDepth);
      continue;
    }

    // Scan strings for PII patterns
    if (typeof value === 'string') {
      let maskedValue = value;
      let matched = false;

      for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
        if (pattern.test(value)) {
          maskedValue = maskedValue.replace(pattern, (match) => {
            return maskString(match, type);
          });
          matched = true;
        }
      }

      if (matched) {
        masked[key] = maskedValue;
      }
    }
  }

  return masked;
};

/**
 * Mask individual string based on type
 */
const maskString = (value: string, type: string): string => {
  if (!value) return value;

  switch (type) {
    case 'email':
      const [local, domain] = value.split('@');
      return `${local[0]}***${local[local.length - 1]}@${domain}`;

    case 'phone':
    case 'mobile':
    case 'telephone':
    case 'whatsapp':
      // Show last 4 digits
      const cleaned = value.replace(/\D/g, '');
      if (cleaned.length >= 4) {
        return `****${cleaned.slice(-4)}`;
      }
      return '****';

    case 'tin':
    case 'accountNumber':
      // Show last 4 digits
      if (value.length >= 4) {
        return `****${value.slice(-4)}`;
      }
      return '****';

    case 'creditCard':
      // Show last 4 digits
      const digits = value.replace(/\D/g, '');
      if (digits.length >= 4) {
        return `**** **** **** ${digits.slice(-4)}`;
      }
      return '****';

    case 'ipAddress':
      // Show first octet only
      const octets = value.split('.');
      if (octets.length === 4) {
        return `${octets[0]}.***.***.***`;
      }
      return '***.***.***.***';

    default:
      // Generic masking - show first and last character
      if (value.length > 4) {
        return `${value[0]}***${value[value.length - 1]}`;
      }
      return '***';
  }
};

/**
 * Middleware to mask PII in responses
 */
export const piiMask = (req: Request, res: Response, next: NextFunction) => {
  // Store original json function
  const originalJson = res.json;

  // Override json function
  res.json = function(body: any) {
    // Don't mask in development if explicitly disabled
    if (process.env.NODE_ENV === 'development' && process.env.DISABLE_PII_MASK === 'true') {
      return originalJson.call(this, body);
    }

    // Mask the response body
    const maskedBody = maskPII(body);

    // Call original json with masked body
    return originalJson.call(this, maskedBody);
  };

  next();
};

/**
 * Mask request body for logging
 */
export const maskForLogging = (obj: any): any => {
  return maskPII(obj);
};

/**
 * Create a safe copy of request for logging
 */
export const createSafeRequestLog = (req: Request): any => {
  return {
    method: req.method,
    path: req.path,
    query: maskPII(req.query),
    params: maskPII(req.params),
    headers: {
      'user-agent': req.headers['user-agent'],
      'content-type': req.headers['content-type'],
      'x-request-id': req.headers['x-request-id']
    },
    ip: req.ip,
    userId: req.user?.id
  };
};

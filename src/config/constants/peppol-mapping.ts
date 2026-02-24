/**
 * Centralized error codes for the entire application
 */

export interface ErrorCode {
  code: string;
  message: string;
  httpStatus: number;
  description: string;
  resolution?: string;
}

export const ERROR_CODES: Record<string, ErrorCode> = {
  // Authentication Errors (AUTH-xxxx)
  AUTH_001: {
    code: 'AUTH_001',
    message: 'Invalid credentials',
    httpStatus: 401,
    description: 'The provided email or password is incorrect',
    resolution: 'Verify your credentials and try again',
  },
  AUTH_002: {
    code: 'AUTH_002',
    message: 'Token expired',
    httpStatus: 401,
    description: 'Your session has expired',
    resolution: 'Refresh your token or login again',
  },
  AUTH_003: {
    code: 'AUTH_003',
    message: 'Invalid token',
    httpStatus: 401,
    description: 'The provided token is invalid',
    resolution: 'Provide a valid token',
  },
  AUTH_004: {
    code: 'AUTH_004',
    message: 'MFA required',
    httpStatus: 403,
    description: 'Multi-factor authentication is required',
    resolution: 'Complete MFA verification',
  },
  AUTH_005: {
    code: 'AUTH_005',
    message: 'Invalid MFA code',
    httpStatus: 401,
    description: 'The provided MFA code is incorrect',
    resolution: 'Enter a valid MFA code',
  },
  AUTH_006: {
    code: 'AUTH_006',
    message: 'Account locked',
    httpStatus: 403,
    description: 'Your account has been locked due to too many attempts',
    resolution: 'Contact support or wait for unlock',
  },
  AUTH_007: {
    code: 'AUTH_007',
    message: 'Insufficient permissions',
    httpStatus: 403,
    description: 'You do not have permission to perform this action',
    resolution: 'Request appropriate permissions',
  },

  // Business Errors (BIZ-xxxx)
  BIZ_001: {
    code: 'BIZ_001',
    message: 'Business not found',
    httpStatus: 404,
    description: 'The specified business does not exist',
    resolution: 'Verify the business ID',
  },
  BIZ_002: {
    code: 'BIZ_002',
    message: 'Business already exists',
    httpStatus: 409,
    description: 'A business with this TIN already exists',
    resolution: 'Use a different TIN or verify your registration',
  },
  BIZ_003: {
    code: 'BIZ_003',
    message: 'Business suspended',
    httpStatus: 403,
    description: 'This business account has been suspended',
    resolution: 'Contact support for reactivation',
  },
  BIZ_004: {
    code: 'BIZ_004',
    message: 'Invalid TIN',
    httpStatus: 400,
    description: 'The provided Tax Identification Number is invalid',
    resolution: 'Provide a valid 10-digit TIN',
  },
  BIZ_005: {
    code: 'BIZ_005',
    message: 'CAC verification failed',
    httpStatus: 400,
    description: 'Corporate Affairs Commission verification failed',
    resolution: 'Verify your CAC registration details',
  },

  // Invoice Errors (INV-xxxx)
  INV_001: {
    code: 'INV_001',
    message: 'Invoice not found',
    httpStatus: 404,
    description: 'The specified invoice does not exist',
    resolution: 'Verify the invoice ID',
  },
  INV_002: {
    code: 'INV_002',
    message: 'Duplicate invoice number',
    httpStatus: 409,
    description: 'An invoice with this number already exists',
    resolution: 'Use a unique invoice number',
  },
  INV_003: {
    code: 'INV_003',
    message: 'Invalid invoice data',
    httpStatus: 400,
    description: 'The invoice data failed validation',
    resolution: 'Check validation errors and fix',
  },
  INV_004: {
    code: 'INV_004',
    message: 'Invoice already submitted to FIRS',
    httpStatus: 409,
    description: 'This invoice has already been submitted',
    resolution: 'Cannot modify submitted invoice',
  },
  INV_005: {
    code: 'INV_005',
    message: 'Invoice rejected by FIRS',
    httpStatus: 400,
    description: 'FIRS rejected the invoice',
    resolution: 'Check FIRS error response and fix',
  },
  INV_006: {
    code: 'INV_006',
    message: 'VAT calculation error',
    httpStatus: 400,
    description: 'VAT amount does not match calculation',
    resolution: 'Recalculate VAT at 7.5%',
  },
  INV_007: {
    code: 'INV_007',
    message: 'Line items required',
    httpStatus: 400,
    description: 'Invoice must have at least one line item',
    resolution: 'Add line items to the invoice',
  },

  // Integration Errors (INT-xxxx)
  INT_001: {
    code: 'INT_001',
    message: 'Integration not found',
    httpStatus: 404,
    description: 'The specified integration does not exist',
    resolution: 'Verify the integration ID',
  },
  INT_002: {
    code: 'INT_002',
    message: 'Integration already exists',
    httpStatus: 409,
    description: 'An integration with this account already exists',
    resolution: 'Use a different account or remove existing',
  },
  INT_003: {
    code: 'INT_003',
    message: 'Integration disconnected',
    httpStatus: 401,
    description: 'The integration has been disconnected',
    resolution: 'Reconnect the integration',
  },
  INT_004: {
    code: 'INT_004',
    message: 'Token expired',
    httpStatus: 401,
    description: 'OAuth token has expired',
    resolution: 'Refresh the token',
  },
  INT_005: {
    code: 'INT_005',
    message: 'Provider error',
    httpStatus: 502,
    description: 'Error from integration provider',
    resolution: 'Check provider status and retry',
  },
  INT_006: {
    code: 'INT_006',
    message: 'Webhook verification failed',
    httpStatus: 401,
    description: 'Webhook signature verification failed',
    resolution: 'Verify webhook secret',
  },
  INT_007: {
    code: 'INT_007',
    message: 'Sync failed',
    httpStatus: 500,
    description: 'Integration sync failed',
    resolution: 'Check logs and retry',
  },

  // FIRS Errors (FIRS-xxxx)
  FIRS_001: {
    code: 'FIRS_001',
    message: 'FIRS service unavailable',
    httpStatus: 503,
    description: 'FIRS API is currently unavailable',
    resolution: 'Retry after a few minutes',
  },
  FIRS_002: {
    code: 'FIRS_002',
    message: 'Invalid CSID',
    httpStatus: 401,
    description: 'Communication Session ID is invalid',
    resolution: 'Re-register with FIRS',
  },
  FIRS_003: {
    code: 'FIRS_003',
    message: 'Certificate expired',
    httpStatus: 401,
    description: 'Digital certificate has expired',
    resolution: 'Renew certificate with FIRS',
  },
  FIRS_004: {
    code: 'FIRS_004',
    message: 'Missing mandatory fields',
    httpStatus: 400,
    description: 'Required fields are missing',
    resolution: 'Check validation errors',
  },
  FIRS_005: {
    code: 'FIRS_005',
    message: 'Invalid signature',
    httpStatus: 401,
    description: 'Digital signature validation failed',
    resolution: 'Check signing process',
  },
  FIRS_006: {
    code: 'FIRS_006',
    message: 'Rate limit exceeded',
    httpStatus: 429,
    description: 'Too many requests to FIRS',
    resolution: 'Wait and retry',
  },
  FIRS_007: {
    code: 'FIRS_007',
    message: 'IRN generation failed',
    httpStatus: 500,
    description: 'Failed to generate Invoice Reference Number',
    resolution: 'Contact support',
  },

  // Payment Errors (PAY-xxxx)
  PAY_001: {
    code: 'PAY_001',
    message: 'Payment failed',
    httpStatus: 400,
    description: 'Payment processing failed',
    resolution: 'Check payment details and retry',
  },
  PAY_002: {
    code: 'PAY_002',
    message: 'Invalid amount',
    httpStatus: 400,
    description: 'Payment amount is invalid',
    resolution: 'Provide a valid amount',
  },
  PAY_003: {
    code: 'PAY_003',
    message: 'Payment method not supported',
    httpStatus: 400,
    description: 'The payment method is not supported',
    resolution: 'Use a different payment method',
  },
  PAY_004: {
    code: 'PAY_004',
    message: 'Payment already processed',
    httpStatus: 409,
    description: 'This payment has already been processed',
    resolution: 'Check payment status',
  },

  // Validation Errors (VAL-xxxx)
  VAL_001: {
    code: 'VAL_001',
    message: 'Validation failed',
    httpStatus: 400,
    description: 'Request validation failed',
    resolution: 'Check validation errors',
  },
  VAL_002: {
    code: 'VAL_002',
    message: 'Invalid email format',
    httpStatus: 400,
    description: 'The provided email is invalid',
    resolution: 'Provide a valid email address',
  },
  VAL_003: {
    code: 'VAL_003',
    message: 'Invalid phone number',
    httpStatus: 400,
    description: 'The provided phone number is invalid',
    resolution: 'Provide a valid Nigerian phone number',
  },
  VAL_004: {
    code: 'VAL_004',
    message: 'Invalid date',
    httpStatus: 400,
    description: 'The provided date is invalid',
    resolution: 'Provide a valid ISO date',
  },
  VAL_005: {
    code: 'VAL_005',
    message: 'Invalid currency',
    httpStatus: 400,
    description: 'The provided currency is invalid',
    resolution: 'Provide a valid ISO 4217 currency code',
  },

  // System Errors (SYS-xxxx)
  SYS_001: {
    code: 'SYS_001',
    message: 'Internal server error',
    httpStatus: 500,
    description: 'An unexpected error occurred',
    resolution: 'Contact support',
  },
  SYS_002: {
    code: 'SYS_002',
    message: 'Database error',
    httpStatus: 500,
    description: 'A database error occurred',
    resolution: 'Contact support',
  },
  SYS_003: {
    code: 'SYS_003',
    message: 'Rate limit exceeded',
    httpStatus: 429,
    description: 'Too many requests',
    resolution: 'Slow down your requests',
  },
  SYS_004: {
    code: 'SYS_004',
    message: 'Service unavailable',
    httpStatus: 503,
    description: 'The service is temporarily unavailable',
    resolution: 'Retry after a few minutes',
  },
  SYS_005: {
    code: 'SYS_005',
    message: 'Timeout',
    httpStatus: 504,
    description: 'The request timed out',
    resolution: 'Retry the request',
  },
};

/**
 * Get error code details
 */
export function getErrorCode(code: string): ErrorCode {
  return ERROR_CODES[code] || ERROR_CODES.SYS_001;
}

/**
 * Create a validation error response
 */
export function createValidationError(
  field: string,
  message: string
): {
  code: string;
  field: string;
  message: string;
} {
  return {
    code: 'VAL_001',
    field,
    message,
  };
}

/**
 * Create error response for API
 */
export function createErrorResponse(
  error: Error | string,
  defaultCode: string = 'SYS_001'
): {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
} {
  const code = typeof error === 'string' ? defaultCode : error.message;
  const errorDetails = getErrorCode(code);
  
  return {
    success: false,
    error: {
      code: errorDetails.code,
      message: errorDetails.message,
      details: typeof error === 'object' && error !== null ? error : undefined,
    },
  };
}

/**
 * HTTP status to error code mapping
 */
export const HTTP_STATUS_TO_ERROR: Record<number, string> = {
  400: 'VAL_001',
  401: 'AUTH_001',
  403: 'AUTH_007',
  404: 'BIZ_001',
  409: 'INV_002',
  429: 'SYS_003',
  500: 'SYS_001',
  502: 'INT_005',
  503: 'SYS_004',
  504: 'SYS_005',
};

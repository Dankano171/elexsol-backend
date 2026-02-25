import { Request, Response, NextFunction } from 'express';
import { AnySchema, ValidationError } from 'joi';
import { logger } from '../config/logger';

export const validate = (schema: AnySchema, property: 'body' | 'query' | 'params' = 'body') => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const { error, value } = schema.validate(req[property], {
        abortEarly: false,
        stripUnknown: true,
        allowUnknown: property === 'query' // Allow unknown query params
      });

      if (error) {
        const errors = error.details.map(detail => ({
          field: detail.path.join('.'),
          message: detail.message,
          type: detail.type
        }));

        logger.debug('Validation failed', {
          property,
          errors,
          body: req.body,
          query: req.query,
          params: req.params
        });

        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          errors
        });
      }

      // Replace with validated value
      req[property] = value;

      next();
    } catch (err) {
      logger.error('Validation middleware error:', err);
      return res.status(500).json({
        success: false,
        error: 'Validation processing failed'
      });
    }
  };
};

/**
 * Validate multiple parts of request
 */
export const validateAll = (schemas: {
  body?: AnySchema;
  query?: AnySchema;
  params?: AnySchema;
}) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const errors: any[] = [];

      if (schemas.body) {
        const { error } = schemas.body.validate(req.body, { abortEarly: false });
        if (error) {
          errors.push(...error.details.map(d => ({
            property: 'body',
            field: d.path.join('.'),
            message: d.message
          })));
        }
      }

      if (schemas.query) {
        const { error } = schemas.query.validate(req.query, { 
          abortEarly: false,
          allowUnknown: true 
        });
        if (error) {
          errors.push(...error.details.map(d => ({
            property: 'query',
            field: d.path.join('.'),
            message: d.message
          })));
        }
      }

      if (schemas.params) {
        const { error } = schemas.params.validate(req.params, { abortEarly: false });
        if (error) {
          errors.push(...error.details.map(d => ({
            property: 'params',
            field: d.path.join('.'),
            message: d.message
          })));
        }
      }

      if (errors.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          errors
        });
      }

      next();
    } catch (err) {
      logger.error('Validation middleware error:', err);
      return res.status(500).json({
        success: false,
        error: 'Validation processing failed'
      });
    }
  };
};

/**
 * Custom validation function
 */
export const validateWith = (
  validator: (req: Request) => { valid: boolean; errors?: string[] }
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = validator(req);

      if (!result.valid) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          errors: result.errors?.map(e => ({ message: e }))
        });
      }

      next();
    } catch (err) {
      logger.error('Custom validation error:', err);
      return res.status(500).json({
        success: false,
        error: 'Validation processing failed'
      });
    }
  };
};

/**
 * Sanitize request body
 */
export const sanitize = (fields: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.body) {
      fields.forEach(field => {
        if (req.body[field]) {
          if (typeof req.body[field] === 'string') {
            // Remove HTML tags and trim
            req.body[field] = req.body[field]
              .replace(/<[^>]*>/g, '')
              .trim();
          }
        }
      });
    }
    next();
  };
};

import admin from 'firebase-admin';
import { logger } from '../../../config/logger';
import { redis } from '../../../config/redis';
import { userRepository } from '../../../repositories/UserRepository';

export interface PushOptions {
  token: string | string[];
  title: string;
  body: string;
  data?: Record<string, string>;
  image?: string;
  badge?: number;
  sound?: string;
  priority?: 'normal' | 'high';
  ttl?: number; // Time to live in seconds
}

export interface PushResult {
  success: boolean;
  messageId?: string;
  error?: string;
  failedTokens?: string[];
}

export interface DeviceRegistration {
  userId: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
  deviceId?: string;
  model?: string;
  appVersion?: string;
  lastUsed: Date;
  active: boolean;
}

export class PushChannel {
  private readonly defaultSound = 'default';
  private readonly defaultPriority = 'high';
  private readonly tokenKeyPrefix = 'push:token:';
  private readonly userTokensPrefix = 'push:user:';

  constructor() {
    // Initialize Firebase Admin if credentials exist
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });

        logger.info('Firebase Admin initialized successfully');
      } catch (error) {
        logger.error('Failed to initialize Firebase Admin:', error);
      }
    }
  }

  /**
   * Send push notification
   */
  async send(options: PushOptions): Promise<PushResult[]> {
    try {
      const tokens = Array.isArray(options.token) ? options.token : [options.token];
      
      if (tokens.length === 0) {
        return [];
      }

      const message = {
        notification: {
          title: options.title,
          body: options.body,
          image: options.image
        },
        data: options.data || {},
        android: {
          priority: options.priority || this.defaultPriority,
          ttl: options.ttl ? options.ttl * 1000 : undefined,
          notification: {
            sound: options.sound || this.defaultSound,
            clickAction: 'FLUTTER_NOTIFICATION_CLICK'
          }
        },
        apns: {
          headers: {
            'apns-priority': options.priority === 'high' ? '10' : '5'
          },
          payload: {
            aps: {
              alert: {
                title: options.title,
                body: options.body
              },
              badge: options.badge,
              sound: options.sound || this.defaultSound
            }
          }
        },
        webpush: {
          headers: {
            TTL: options.ttl?.toString() || '3600'
          },
          notification: {
            icon: options.image || '/icon.png',
            badge: '/badge.png'
          }
        }
      };

      // Send to Firebase
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        ...message
      });

      const results: PushResult[] = [];
      
      // Process results
      response.responses.forEach((resp, idx) => {
        if (resp.success) {
          results.push({
            success: true,
            messageId: resp.messageId
          });
        } else {
          results.push({
            success: false,
            error: resp.error?.message,
            failedTokens: [tokens[idx]]
          });

          // Remove invalid token
          if (resp.error?.code === 'messaging/invalid-registration-token' ||
              resp.error?.code === 'messaging/registration-token-not-registered') {
            this.removeToken(tokens[idx]);
          }
        }
      });

      logger.info('Push notifications sent', {
        success: response.successCount,
        failure: response.failureCount
      });

      return results;
    } catch (error) {
      logger.error('Error sending push notification:', error);
      throw error;
    }
  }

  /**
   * Send notification to user
   */
  async sendNotification(data: {
    userId?: string;
    businessId: string;
    title: string;
    body: string;
    data?: Record<string, any>;
    preferences: any;
  }): Promise<void> {
    if (!data.userId) {
      return;
    }

    // Get user's push tokens
    const tokens = await this.getUserTokens(data.userId);
    
    if (tokens.length === 0) {
      logger.debug('No push tokens found for user', { userId: data.userId });
      return;
    }

    await this.send({
      token: tokens,
      title: data.title,
      body: data.body,
      data: data.data as Record<string, string>,
      priority: 'high'
    });
  }

  /**
   * Register device token
   */
  async registerToken(registration: DeviceRegistration): Promise<void> {
    const tokenKey = `${this.tokenKeyPrefix}${registration.token}`;
    const userKey = `${this.userTokensPrefix}${registration.userId}`;

    // Store token details
    await redis.setex(
      tokenKey,
      30 * 24 * 60 * 60, // 30 days
      JSON.stringify({
        ...registration,
        lastUsed: new Date().toISOString()
      })
    );

    // Add to user's token set
    await redis.sadd(userKey, registration.token);

    logger.info('Device token registered', {
      userId: registration.userId,
      platform: registration.platform
    });
  }

  /**
   * Remove device token
   */
  async removeToken(token: string): Promise<void> {
    const tokenKey = `${this.tokenKeyPrefix}${token}`;
    const tokenData = await redis.get(tokenKey);

    if (tokenData) {
      const { userId } = JSON.parse(tokenData);
      const userKey = `${this.userTokensPrefix}${userId}`;

      await redis.srem(userKey, token);
      await redis.del(tokenKey);

      logger.info('Device token removed', { token, userId });
    }
  }

  /**
   * Get user's active tokens
   */
  async getUserTokens(userId: string): Promise<string[]> {
    const userKey = `${this.userTokensPrefix}${userId}`;
    const tokens = await redis.smembers(userKey);
    
    // Filter out expired tokens
    const validTokens: string[] = [];
    
    for (const token of tokens) {
      const tokenKey = `${this.tokenKeyPrefix}${token}`;
      const exists = await redis.exists(tokenKey);
      
      if (exists) {
        validTokens.push(token);
      } else {
        // Clean up expired token from set
        await redis.srem(userKey, token);
      }
    }

    return validTokens;
  }

  /**
   * Send to topic
   */
  async sendToTopic(
    topic: string,
    options: Omit<PushOptions, 'token'>
  ): Promise<PushResult> {
    try {
      const message = {
        topic,
        notification: {
          title: options.title,
          body: options.body,
          image: options.image
        },
        data: options.data || {},
        android: {
          priority: options.priority || this.defaultPriority
        },
        apns: {
          payload: {
            aps: {
              alert: {
                title: options.title,
                body: options.body
              },
              badge: options.badge,
              sound: options.sound || this.defaultSound
            }
          }
        }
      };

      const response = await admin.messaging().send(message);

      return {
        success: true,
        messageId: response
      };
    } catch (error) {
      logger.error('Error sending to topic:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Subscribe to topic
   */
  async subscribeToTopic(tokens: string[], topic: string): Promise<void> {
    try {
      await admin.messaging().subscribeToTopic(tokens, topic);
      logger.info('Subscribed to topic', { topic, tokenCount: tokens.length });
    } catch (error) {
      logger.error('Error subscribing to topic:', error);
      throw error;
    }
  }

  /**
   * Unsubscribe from topic
   */
  async unsubscribeFromTopic(tokens: string[], topic: string): Promise<void> {
    try {
      await admin.messaging().unsubscribeFromTopic(tokens, topic);
      logger.info('Unsubscribed from topic', { topic, tokenCount: tokens.length });
    } catch (error) {
      logger.error('Error unsubscribing from topic:', error);
      throw error;
    }
  }

  /**
   * Clean up old tokens
   */
  async cleanupTokens(): Promise<number> {
    let cleaned = 0;
    const pattern = `${this.tokenKeyPrefix}*`;
    const keys = await redis.keys(pattern);

    for (const key of keys) {
      const ttl = await redis.ttl(key);
      if (ttl < 0) {
        // Token expired
        const token = key.replace(this.tokenKeyPrefix, '');
        await this.removeToken(token);
        cleaned++;
      }
    }

    logger.info('Cleaned up expired tokens', { count: cleaned });
    return cleaned;
  }
}

export const pushChannel = new PushChannel();

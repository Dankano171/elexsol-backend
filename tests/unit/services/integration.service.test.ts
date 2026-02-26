import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { integrationService } from '../../../src/services/integrations/IntegrationService';
import { accountIntegrationRepository } from '../../../src/repositories/AccountIntegrationRepository';
import { zohoProvider } from '../../../src/services/integrations/providers/ZohoProvider';
import { whatsappProvider } from '../../../src/services/integrations/providers/WhatsAppProvider';
import { quickbooksProvider } from '../../../src/services/integrations/providers/QuickBooksProvider';
import { v4 as uuidv4 } from 'uuid';

// Mock dependencies
vi.mock('../../../src/repositories/AccountIntegrationRepository');
vi.mock('../../../src/services/integrations/providers/ZohoProvider');
vi.mock('../../../src/services/integrations/providers/WhatsAppProvider');
vi.mock('../../../src/services/integrations/providers/QuickBooksProvider');

describe('IntegrationService', () => {
  const mockBusinessId = uuidv4();
  const mockUserId = uuidv4();
  const mockIntegrationId = uuidv4();

  const mockIntegration = {
    id: mockIntegrationId,
    business_id: mockBusinessId,
    provider: 'zoho',
    account_email: 'test@example.com',
    encrypted_access_token: Buffer.from('encrypted-token'),
    encrypted_refresh_token: Buffer.from('encrypted-refresh'),
    token_expires_at: new Date(Date.now() + 86400000),
    scopes: ['ZohoBooks.fullaccess.all'],
    status: 'active',
    sync_status: 'idle',
    settings: {}
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('connect', () => {
    it('should connect Zoho integration successfully', async () => {
      // Arrange
      const config = {
        provider: 'zoho' as const,
        businessId: mockBusinessId,
        accountEmail: 'test@example.com',
        accessToken: 'zoho-token',
        refreshToken: 'zoho-refresh',
        scopes: ['ZohoBooks.fullaccess.all']
      };

      vi.mocked(accountIntegrationRepository.findByEmail).mockResolvedValue(null);
      vi.mocked(zohoProvider.testConnection).mockResolvedValue({
        success: true,
        accountId: 'zoho-account-id'
      });
      vi.mocked(accountIntegrationRepository.createIntegration).mockResolvedValue({
        ...mockIntegration,
        provider: 'zoho'
      });

      // Act
      const result = await integrationService.connect(config, mockUserId);

      // Assert
      expect(result).toBeDefined();
      expect(result.provider).toBe('zoho');
      expect(zohoProvider.testConnection).toHaveBeenCalledWith('zoho-token');
      expect(accountIntegrationRepository.createIntegration).toHaveBeenCalled();
    });

    it('should connect WhatsApp integration successfully', async () => {
      // Arrange
      const config = {
        provider: 'whatsapp' as const,
        businessId: mockBusinessId,
        accountEmail: 'business@example.com',
        accessToken: 'whatsapp-token',
        scopes: ['whatsapp_business_messages']
      };

      vi.mocked(accountIntegrationRepository.findByEmail).mockResolvedValue(null);
      vi.mocked(whatsappProvider.testConnection).mockResolvedValue({
        success: true,
        accountId: 'whatsapp-account-id'
      });
      vi.mocked(accountIntegrationRepository.createIntegration).mockResolvedValue({
        ...mockIntegration,
        provider: 'whatsapp'
      });

      // Act
      const result = await integrationService.connect(config, mockUserId);

      // Assert
      expect(result).toBeDefined();
      expect(result.provider).toBe('whatsapp');
      expect(whatsappProvider.testConnection).toHaveBeenCalledWith('whatsapp-token');
    });

    it('should throw error if integration already exists', async () => {
      // Arrange
      const config = {
        provider: 'zoho' as const,
        businessId: mockBusinessId,
        accountEmail: 'test@example.com',
        accessToken: 'zoho-token'
      };

      vi.mocked(accountIntegrationRepository.findByEmail).mockResolvedValue(mockIntegration);

      // Act & Assert
      await expect(integrationService.connect(config, mockUserId))
        .rejects.toThrow('Integration with zoho already exists');
    });

    it('should throw error if connection test fails', async () => {
      // Arrange
      const config = {
        provider: 'zoho' as const,
        businessId: mockBusinessId,
        accountEmail: 'test@example.com',
        accessToken: 'invalid-token'
      };

      vi.mocked(accountIntegrationRepository.findByEmail).mockResolvedValue(null);
      vi.mocked(zohoProvider.testConnection).mockResolvedValue({
        success: false,
        error: 'Invalid token'
      });

      // Act & Assert
      await expect(integrationService.connect(config, mockUserId))
        .rejects.toThrow('Connection test failed: Invalid token');
    });
  });

  describe('disconnect', () => {
    it('should disconnect integration successfully', async () => {
      // Arrange
      vi.mocked(accountIntegrationRepository.findOne).mockResolvedValue(mockIntegration);
      vi.mocked(accountIntegrationRepository.disconnect).mockResolvedValue(true);

      // Act
      await integrationService.disconnect(mockIntegrationId, mockBusinessId, mockUserId);

      // Assert
      expect(accountIntegrationRepository.findOne).toHaveBeenCalledWith({
        id: mockIntegrationId,
        business_id: mockBusinessId
      });
      expect(accountIntegrationRepository.disconnect).toHaveBeenCalledWith(mockIntegrationId, mockBusinessId);
    });

    it('should throw error if integration not found', async () => {
      // Arrange
      vi.mocked(accountIntegrationRepository.findOne).mockResolvedValue(null);

      // Act & Assert
      await expect(integrationService.disconnect(mockIntegrationId, mockBusinessId, mockUserId))
        .rejects.toThrow('Integration not found');
    });
  });

  describe('sync', () => {
    it('should sync Zoho integration successfully', async () => {
      // Arrange
      const mockSyncResult = {
        success: true,
        recordsSynced: 50,
        errors: []
      };

      vi.mocked(accountIntegrationRepository.findOne).mockResolvedValue(mockIntegration);
      vi.mocked(accountIntegrationRepository.getAccessToken).mockResolvedValue('zoho-token');
      vi.mocked(zohoProvider.sync).mockResolvedValue(mockSyncResult);
      vi.mocked(accountIntegrationRepository.updateSyncStatus).mockResolvedValue();

      // Act
      const result = await integrationService.sync(mockIntegrationId, mockBusinessId);

      // Assert
      expect(result).toEqual(mockSyncResult);
      expect(accountIntegrationRepository.getAccessToken).toHaveBeenCalledWith(mockIntegrationId, mockBusinessId);
      expect(zohoProvider.sync).toHaveBeenCalledWith('zoho-token', mockIntegration.settings);
    });

    it('should throw error if integration not found', async () => {
      // Arrange
      vi.mocked(accountIntegrationRepository.findOne).mockResolvedValue(null);

      // Act & Assert
      await expect(integrationService.sync(mockIntegrationId, mockBusinessId))
        .rejects.toThrow('Integration not found');
    });

    it('should throw error if integration is not active', async () => {
      // Arrange
      const inactiveIntegration = { ...mockIntegration, status: 'expired' };
      vi.mocked(accountIntegrationRepository.findOne).mockResolvedValue(inactiveIntegration);

      // Act & Assert
      await expect(integrationService.sync(mockIntegrationId, mockBusinessId))
        .rejects.toThrow('Integration is expired');
    });

    it('should throw error if access token cannot be retrieved', async () => {
      // Arrange
      vi.mocked(accountIntegrationRepository.findOne).mockResolvedValue(mockIntegration);
      vi.mocked(accountIntegrationRepository.getAccessToken).mockResolvedValue(null);

      // Act & Assert
      await expect(integrationService.sync(mockIntegrationId, mockBusinessId))
        .rejects.toThrow('Unable to get access token');
    });
  });

  describe('refreshToken', () => {
    it('should refresh Zoho token successfully', async () => {
      // Arrange
      const refreshResult = {
        accessToken: 'new-zoho-token',
        refreshToken: 'new-refresh',
        expiresAt: new Date(Date.now() + 3600000)
      };

      vi.mocked(accountIntegrationRepository.findOne).mockResolvedValue(mockIntegration);
      vi.mocked(accountIntegrationRepository.getRefreshToken).mockResolvedValue('old-refresh');
      vi.mocked(zohoProvider.refreshToken).mockResolvedValue(refreshResult);
      vi.mocked(accountIntegrationRepository.updateTokens).mockResolvedValue(mockIntegration);

      // Act
      await integrationService.refreshToken(mockIntegrationId, mockBusinessId);

      // Assert
      expect(accountIntegrationRepository.getRefreshToken).toHaveBeenCalledWith(mockIntegrationId, mockBusinessId);
      expect(zohoProvider.refreshToken).toHaveBeenCalledWith('old-refresh');
      expect(accountIntegrationRepository.updateTokens).toHaveBeenCalledWith(
        mockIntegrationId,
        'new-zoho-token',
        'new-refresh',
        refreshResult.expiresAt
      );
    });

    it('should throw error if integration not found', async () => {
      // Arrange
      vi.mocked(accountIntegrationRepository.findOne).mockResolvedValue(null);

      // Act & Assert
      await expect(integrationService.refreshToken(mockIntegrationId, mockBusinessId))
        .rejects.toThrow('Integration not found');
    });

    it('should throw error if no refresh token available', async () => {
      // Arrange
      vi.mocked(accountIntegrationRepository.findOne).mockResolvedValue(mockIntegration);
      vi.mocked(accountIntegrationRepository.getRefreshToken).mockResolvedValue(null);

      // Act & Assert
      await expect(integrationService.refreshToken(mockIntegrationId, mockBusinessId))
        .rejects.toThrow('No refresh token available');
    });
  });

  describe('getStatus', () => {
    it('should return integration status', async () => {
      // Arrange
      const mockHealth = {
        healthy: true,
        issues: []
      };

      vi.mocked(accountIntegrationRepository.findOne).mockResolvedValue(mockIntegration);
      vi.mocked(accountIntegrationRepository.getHealthStatus).mockResolvedValue(mockHealth);

      // Act
      const status = await integrationService.getStatus(mockIntegrationId, mockBusinessId);

      // Assert
      expect(status).toBeDefined();
      expect(status.id).toBe(mockIntegrationId);
      expect(status.status).toBe('active');
      expect(status.health).toEqual(mockHealth);
    });

    it('should throw error if integration not found', async () => {
      // Arrange
      vi.mocked(accountIntegrationRepository.findOne).mockResolvedValue(null);

      // Act & Assert
      await expect(integrationService.getStatus(mockIntegrationId, mockBusinessId))
        .rejects.toThrow('Integration not found');
    });
  });
});

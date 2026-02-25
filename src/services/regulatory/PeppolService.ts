import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { businessRepository } from '../../repositories/BusinessRepository';
import { logger } from '../../config/logger';
import { peppolToFIRS, firsToPeppol } from '../../config/constants/peppol-mapping';
import xml2js from 'xml2js';
import axios from 'axios';
import { createHash } from 'crypto';

export interface PeppolDocument {
  id: string;
  type: 'invoice' | 'credit_note' | 'debit_note';
  profile: 'bis3' | 'firs';
  content: string;
  hash: string;
  createdAt: Date;
}

export interface PeppolValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
    code: string;
  }>;
  warnings: Array<{
    path: string;
    message: string;
  }>;
}

export class PeppolService {
  private readonly schemaUrl = 'https://docs.peppol.eu/poacc/bis/3.0/';

  /**
   * Convert Peppol BIS 3.0 to FIRS format
   */
  async convertPeppolToFIRS(peppolXml: string): Promise<any> {
    try {
      // Parse Peppol XML
      const parser = new xml2js.Parser({ explicitArray: false });
      const peppolObj = await parser.parseStringPromise(peppolXml);

      // Transform to FIRS format
      const firsData = peppolToFIRS(peppolObj);

      return firsData;
    } catch (error) {
      logger.error('Error converting Peppol to FIRS:', error);
      throw new Error(`Peppol conversion failed: ${error.message}`);
    }
  }

  /**
   * Convert FIRS format to Peppol BIS 3.0
   */
  async convertFIRSToPeppol(firsData: any): Promise<string> {
    try {
      // Transform to Peppol format
      const peppolObj = firsToPeppol(firsData);

      // Build XML
      const builder = new xml2js.Builder({
        xmldec: { version: '1.0', encoding: 'UTF-8' },
        renderOpts: { pretty: true, indent: '  ' },
        headless: false
      });

      return builder.buildObject(peppolObj);
    } catch (error) {
      logger.error('Error converting FIRS to Peppol:', error);
      throw new Error(`Peppol conversion failed: ${error.message}`);
    }
  }

  /**
   * Validate Peppol document
   */
  async validatePeppolDocument(peppolXml: string): Promise<PeppolValidationResult> {
    const errors: PeppolValidationResult['errors'] = [];
    const warnings: PeppolValidationResult['warnings'] = [];

    try {
      // Parse XML
      const parser = new xml2js.Parser({ explicitArray: false });
      const doc = await parser.parseStringPromise(peppolXml);

      // Check required namespaces
      if (!doc['Invoice']?.['$']?.xmlns?.includes('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2')) {
        errors.push({
          path: '/Invoice',
          message: 'Missing or invalid UBL namespace',
          code: 'PEP-001'
        });
      }

      // Validate required fields
      const requiredFields = [
        { path: '/Invoice/cbc:ID', name: 'Invoice ID' },
        { path: '/Invoice/cbc:IssueDate', name: 'Issue Date' },
        { path: '/Invoice/cbc:InvoiceTypeCode', name: 'Invoice Type' },
        { path: '/Invoice/cbc:DocumentCurrencyCode', name: 'Currency' },
        { path: '/Invoice/cac:AccountingSupplierParty', name: 'Supplier' },
        { path: '/Invoice/cac:AccountingCustomerParty', name: 'Customer' },
        { path: '/Invoice/cac:LegalMonetaryTotal/cbc:PayableAmount', name: 'Total Amount' }
      ];

      for (const field of requiredFields) {
        const value = this.getXmlValue(doc, field.path);
        if (!value) {
          errors.push({
            path: field.path,
            message: `Missing required field: ${field.name}`,
            code: 'PEP-002'
          });
        }
      }

      // Validate amounts
      const lineTotal = this.calculateLineTotal(doc);
      const payableAmount = this.getXmlValue(doc, '/Invoice/cac:LegalMonetaryTotal/cbc:PayableAmount');

      if (Math.abs(lineTotal - parseFloat(payableAmount)) > 0.01) {
        warnings.push({
          path: '/Invoice/cac:LegalMonetaryTotal/cbc:PayableAmount',
          message: 'Payable amount does not match sum of line items'
        });
      }

      // Validate tax calculations
      const taxTotal = this.getXmlValue(doc, '/Invoice/cac:TaxTotal/cbc:TaxAmount');
      const calculatedTax = this.calculateTaxTotal(doc);

      if (Math.abs(calculatedTax - parseFloat(taxTotal)) > 0.01) {
        warnings.push({
          path: '/Invoice/cac:TaxTotal/cbc:TaxAmount',
          message: 'Tax amount does not match calculated tax'
        });
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings
      };
    } catch (error) {
      logger.error('Error validating Peppol document:', error);
      return {
        valid: false,
        errors: [{
          path: '',
          message: `Validation failed: ${error.message}`,
          code: 'PEP-999'
        }],
        warnings: []
      };
    }
  }

  /**
   * Generate Peppol document hash
   */
  generateDocumentHash(xml: string): string {
    // Normalize XML (remove whitespace, sort attributes)
    const normalized = this.normalizeXML(xml);
    
    // Generate SHA-256 hash
    return createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * Normalize XML for hashing
   */
  private normalizeXML(xml: string): string {
    // Remove comments
    xml = xml.replace(/<!--[\s\S]*?-->/g, '');
    
    // Normalize whitespace
    xml = xml.replace(/>\s+</g, '><');
    xml = xml.replace(/\s+/g, ' ').trim();
    
    // Sort attributes (simplified - in production, use proper XML canonicalization)
    return xml;
  }

  /**
   * Get value from XML object using path
   */
  private getXmlValue(obj: any, path: string): string {
    const parts = path.split('/').filter(p => p);
    let current = obj;

    for (const part of parts) {
      if (!current || typeof current !== 'object') {
        return '';
      }

      // Handle namespaces
      const keys = Object.keys(current);
      const matchingKey = keys.find(k => 
        k.endsWith(`:${part}`) || k === part
      );

      if (!matchingKey) {
        return '';
      }

      current = current[matchingKey];

      // Handle arrays
      if (Array.isArray(current)) {
        current = current[0];
      }
    }

    return current || '';
  }

  /**
   * Calculate total from line items
   */
  private calculateLineTotal(doc: any): number {
    let total = 0;
    const lines = doc?.Invoice?.['cac:InvoiceLine'];

    if (Array.isArray(lines)) {
      for (const line of lines) {
        const amount = parseFloat(
          line?.['cbc:LineExtensionAmount'] || '0'
        );
        total += amount;
      }
    }

    return total;
  }

  /**
   * Calculate tax total
   */
  private calculateTaxTotal(doc: any): number {
    let total = 0;
    const taxLines = doc?.Invoice?.['cac:TaxTotal'];

    if (Array.isArray(taxLines)) {
      for (const line of taxLines) {
        const amount = parseFloat(
          line?.['cbc:TaxAmount'] || '0'
        );
        total += amount;
      }
    }

    return total;
  }

  /**
   * Send document to Peppol network
   */
  async sendToPeppol(
    businessId: string,
    document: PeppolDocument
  ): Promise<{
    success: boolean;
    messageId?: string;
    error?: string;
  }> {
    try {
      // Get business Peppol configuration
      const business = await businessRepository.findById(businessId);
      
      if (!business) {
        throw new Error('Business not found');
      }

      // In production, this would send to a Peppol access point
      // This is a placeholder implementation
      const response = await axios.post(
        process.env.PEPPOL_AP_URL || 'https://ap.example.com/submit',
        document.content,
        {
          headers: {
            'Content-Type': 'application/xml',
            'X-Peppol-ID': business.metadata?.peppol_id,
            'X-Document-ID': document.id,
            'X-Document-Hash': document.hash
          },
          timeout: 30000
        }
      );

      return {
        success: response.status === 200,
        messageId: response.data?.MessageID
      };
    } catch (error) {
      logger.error('Error sending to Peppol:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Receive document from Peppol
   */
  async receiveFromPeppol(
    peppolXml: string,
    headers: any
  ): Promise<{
    document: PeppolDocument;
    businessId?: string;
  }> {
    try {
      // Validate document
      const validation = await this.validatePeppolDocument(peppolXml);
      
      if (!validation.valid) {
        throw new Error(`Invalid Peppol document: ${validation.errors[0]?.message}`);
      }

      // Parse to extract recipient
      const parser = new xml2js.Parser({ explicitArray: false });
      const doc = await parser.parseStringPromise(peppolXml);

      // Extract recipient ID (this would depend on Peppol participant identifier scheme)
      const recipientId = doc?.Invoice?.cac:AccountingCustomerParty?.cac:Party?.cbc:EndpointID;
      
      // Find business by Peppol ID
      const business = await businessRepository.findOne({
        'metadata.peppol_id': recipientId
      });

      // Generate document hash
      const hash = this.generateDocumentHash(peppolXml);

      const document: PeppolDocument = {
        id: headers['x-document-id'] || `doc-${Date.now()}`,
        type: 'invoice',
        profile: 'bis3',
        content: peppolXml,
        hash,
        createdAt: new Date()
      };

      return {
        document,
        businessId: business?.id
      };
    } catch (error) {
      logger.error('Error receiving from Peppol:', error);
      throw error;
    }
  }

  /**
   * Get Peppol validation schema
   */
  async getValidationSchema(): Promise<any> {
    try {
      // In production, this would fetch the latest schemas from Peppol
      // This is a placeholder
      return {
        version: '3.0',
        rules: [
          'All mandatory fields must be present',
          'Amounts must be positive',
          'Tax calculations must be correct',
          'Dates must be valid',
          'Parties must have valid identifiers'
        ]
      };
    } catch (error) {
      logger.error('Error fetching Peppol schema:', error);
      throw error;
    }
  }

  /**
   * Generate Peppol response (acknowledgment)
   */
  generateResponse(
    originalId: string,
    status: 'accepted' | 'rejected',
    reason?: string
  ): string {
    const response = {
      'Response': {
        '@': {
          xmlns: 'urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2'
        },
        'cbc:ID': `RESP-${Date.now()}`,
        'cbc:IssueDate': new Date().toISOString().split('T')[0],
        'cbc:ResponseCode': status === 'accepted' ? 'AP' : 'RE',
        'cbc:Description': reason || `${status} successfully`,
        'cac:SenderParty': {
          'cac:PartyName': {
            'cbc:Name': 'Elexsol Gateway'
          }
        },
        'cac:DocumentReference': {
          'cbc:ID': originalId
        }
      }
    };

    const builder = new xml2js.Builder();
    return builder.buildObject(response);
  }
}

export const peppolService = new PeppolService();

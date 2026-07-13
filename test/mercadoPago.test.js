import { jest } from '@jest/globals';

jest.unstable_mockModule('mercadopago', () => ({
  MercadoPagoConfig: jest.fn(),
  Preference: jest.fn().mockImplementation(() => ({
    create: jest.fn().mockResolvedValue({ id: 'pref_123', init_point: 'url' })
  })),
  Payment: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue({ id: '123', status: 'approved' })
  }))
}));

let mp;

describe('MercadoPago Module', () => {
  beforeAll(async () => {
    mp = await import('../src/mercadoPago.js');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createCheckoutPreference', () => {
    it('should create preference', async () => {
      const result = await mp.createCheckoutPreference({
        amount: 100,
        title: 'Test Item',
        description: 'Test Desc',
        currency: 'ARS',
        payerEmail: 'test@test.com',
        externalReference: 'ext_1',
        orderId: 1,
        orderIds: [1],
        items: [],
        backUrls: {},
        notificationUrl: 'url'
      });
      expect(result.id).toBe('pref_123');
    });
  });

  describe('generateExternalReference', () => {
    it('should generate uuid', async () => {
      const result = await mp.generateExternalReference();
      expect(result.externalReference).toBeDefined();
    });
  });

  describe('getPaymentById', () => {
    it('should return payment', async () => {
      const result = await mp.getPaymentById('123');
      expect(result.id).toBe('123');
      expect(result.status).toBe('approved');
    });
  });
});

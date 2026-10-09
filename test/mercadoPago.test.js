import { jest } from '@jest/globals';

const preferenceCreate = jest.fn().mockResolvedValue({ id: 'pref_123', init_point: 'url' });
const paymentGet = jest.fn().mockResolvedValue({ id: '123', status: 'approved' });

jest.unstable_mockModule('mercadopago', () => ({
  MercadoPagoConfig: jest.fn(),
  Preference: jest.fn().mockImplementation(() => ({
    create: preferenceCreate
  })),
  Payment: jest.fn().mockImplementation(() => ({
    get: paymentGet,
    search: jest.fn().mockResolvedValue({ results: [{ id: '123', status: 'approved' }] })
  })),
  PaymentRefund: jest.fn().mockImplementation(() => ({
    create: jest.fn().mockResolvedValue({ id: '123', status: 'refunded' })
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
    it('charges a single item, only via instantly-resolving payment types, expiring with the hold', async () => {
      const result = await mp.createCheckoutPreference({
        amount: 1500,
        title: 'Reserva ParkLink',
        description: 'Test Desc',
        currency: 'ARS',
        payerEmail: 'test@test.com',
        externalReference: 'booking-1',
        backUrls: {},
        notificationUrl: 'url',
        expiresAt: '2026-10-05T12:05:00Z',
      });

      expect(result.id).toBe('pref_123');
      const body = preferenceCreate.mock.calls[0][0].body;
      expect(body.items).toEqual([
        { title: 'Reserva ParkLink', description: 'Test Desc', quantity: 1, unit_price: 1500, currency_id: 'ARS' },
      ]);
      expect(body.binary_mode).toBe(true);
      expect(body.payment_methods.excluded_payment_types).toEqual([{ id: 'ticket' }, { id: 'atm' }]);
      expect(body.expires).toBe(true);
      expect(body.expiration_date_to).toBe('2026-10-05T12:05:00.000Z');
    });
  });

  describe('getPaymentById', () => {
    it('should return payment', async () => {
      const result = await mp.getPaymentById('123');
      expect(result.id).toBe('123');
      expect(result.status).toBe('approved');
    });

    it('never fabricates a payment for a mock- id -- it always asks Mercado Pago', async () => {
      await mp.getPaymentById('mock-approved-999-1500-ref123');
      expect(paymentGet).toHaveBeenCalledWith({ id: 'mock-approved-999-1500-ref123' });
    });
  });

  describe('searchPaymentByExternalReference', () => {
    it('should search payment by external reference', async () => {
      const result = await mp.searchPaymentByExternalReference('ext_1');
      expect(result).toBeDefined();
      expect(result.id).toBe('123');
    });
  });

  describe('refundPayment', () => {
    it('should return mocked refund for mock- id', async () => {
      const result = await mp.refundPayment('mock-approved-123-1000-ref1');
      expect(result.mocked).toBe(true);
      expect(result.status).toBe('refunded');
    });

    it('should return mocked refund for a demo-pay id', async () => {
      const result = await mp.refundPayment('demo-fa30af7c-72b6-411d-8214-5ce23bbcf19d');
      expect(result.mocked).toBe(true);
    });

    it('should return mocked refund for seed-demo- id', async () => {
      const result = await mp.refundPayment('seed-demo-fa30af7c-72b6-411d-8214-5ce23bbcf19d');
      expect(result.mocked).toBe(true);
      expect(result.status).toBe('refunded');
    });
  });

  describe('describeRefundError', () => {
    it('reads "Unauthorized use of live credentials" as a test-user payment, never retryable', () => {
      const failure = mp.describeRefundError({
        message: 'Unauthorized use of live credentials', error: 'unauthorized', status: 401,
        cause: [{ code: 7, description: 'Unauthorized use of live credentials' }],
      });
      expect(failure).toEqual(expect.objectContaining({ code: 'test_payment', permanent: true }));
      expect(failure.detail).toContain('live credentials');
    });

    it('reads a payment Mercado Pago does not know as not found, never retryable', () => {
      expect(mp.describeRefundError({ error: 'resource not found', message: 'Si quieres conocer los recursos...' }))
        .toEqual(expect.objectContaining({ code: 'payment_not_found', permanent: true }));
    });

    it('reads other 401/403s as unauthorized, never retryable', () => {
      expect(mp.describeRefundError({ status: 403, message: 'forbidden' }))
        .toEqual(expect.objectContaining({ code: 'unauthorized', permanent: true }));
    });

    it('treats timeouts, outages and anything unknown as transient, worth retrying', () => {
      expect(mp.describeRefundError(new Error('timeout of 10000ms exceeded')))
        .toEqual({ code: 'transient', permanent: false, detail: 'timeout of 10000ms exceeded' });
      expect(mp.describeRefundError({ status: 500, message: 'internal error' }).code).toBe('transient');
      expect(mp.describeRefundError(undefined).code).toBe('transient');
    });
  });
});

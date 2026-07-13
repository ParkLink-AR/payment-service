import { jest } from '@jest/globals';
import request from 'supertest';
import crypto from 'crypto';

jest.unstable_mockModule('../src/db.js', () => ({
  pool: {
    query: jest.fn()
  },
  getTransactionByExternalReference: jest.fn(),
  getTransactionByPaymentId: jest.fn(),
  saveTransaction: jest.fn(),
  getTotalTransactionAmount: jest.fn(),
  getTransactionAmountByPeriod: jest.fn(),
  markTransactionAsRefunded: jest.fn()
}));

jest.unstable_mockModule('../src/mercadoPago.js', () => ({
  createCheckoutPreference: jest.fn(),
  generateExternalReference: jest.fn(),
  getPaymentById: jest.fn()
}));

const {
  pool,
  getTransactionByExternalReference,
  getTransactionByPaymentId,
  saveTransaction,
  getTotalTransactionAmount,
  getTransactionAmountByPeriod,
  markTransactionAsRefunded
} = await import('../src/db.js');

const {
  createCheckoutPreference,
  generateExternalReference,
  getPaymentById
} = await import('../src/mercadoPago.js');

const { createApp } = await import('../src/app.js');

describe('Payment Service App', () => {
  let app;
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  beforeAll(() => {
    app = createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /health', () => {
    it('should return 200 ok when db is healthy', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('should return 500 when db fails', async () => {
      pool.query.mockRejectedValueOnce(new Error('DB connection failed'));
      const res = await request(app).get('/health');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ status: 'error', message: 'DB connection failed' });
    });
  });

  describe('POST /api/payments/create-preference', () => {
    it('should return 400 if amount is not a positive number', async () => {
      const res = await request(app).post('/api/payments/create-preference').send({ amount: -10 });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('amount must be a positive number');
    });

    it('should create preference successfully', async () => {
      createCheckoutPreference.mockResolvedValueOnce({
        id: 'pref_123',
        init_point: 'https://mp.com/checkout/123'
      });

      const res = await request(app).post('/api/payments/create-preference').send({
        amount: 100,
        orderId: 1
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        preferenceId: 'pref_123',
        checkoutUrl: 'https://mp.com/checkout/123',
        orderId: 1
      });
      expect(res.body.externalReference).toBeDefined();
    });

    it('should handle internal errors', async () => {
      createCheckoutPreference.mockRejectedValueOnce(new Error('MP Error'));
      const res = await request(app).post('/api/payments/create-preference').send({ amount: 100 });
      expect(res.status).toBe(500);
      expect(res.body.message).toBe('Error creating Mercado Pago preference');
    });
  });

  describe('POST /api/payments/external-reference', () => {
    it('should generate external reference', async () => {
      generateExternalReference.mockResolvedValueOnce({ externalReference: 'ext_ref_123' });
      const res = await request(app).post('/api/payments/external-reference');
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ externalReference: 'ext_ref_123' });
    });

    it('should handle internal errors', async () => {
      generateExternalReference.mockRejectedValueOnce(new Error('Error generating'));
      const res = await request(app).post('/api/payments/external-reference');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/payments/webhook', () => {
    beforeEach(() => {
      global.fetch = jest.fn();
    });

    const getValidHeaders = (paymentId) => {
      const ts = Date.now().toString();
      const requestId = 'req_123';
      const secret = 'fake_secret';
      const signature = crypto.createHmac('sha256', secret)
        .update(`id:${paymentId};request-id:${requestId};ts:${ts};`)
        .digest('hex');
      
      return {
        'x-request-id': requestId,
        'x-signature': `ts=${ts},v1=${signature}`
      };
    };

    it('should ignore if missing paymentId', async () => {
      // paymentId undefined, but we need to pass verification which needs a paymentId in headers/query to verify
      const headers = getValidHeaders('none');
      const res = await request(app).post('/api/payments/webhook')
        .set(headers)
        .send({ type: 'other_topic', data: { id: 'none' } });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Webhook ignored');
    });

    it('should process payment and reconcile if approved', async () => {
      getPaymentById.mockResolvedValueOnce({ id: '123', status: 'approved', external_reference: 'ext_123' });
      saveTransaction.mockResolvedValueOnce({ id: 'txn_123', external_reference: 'ext_123' });
      global.fetch.mockResolvedValueOnce({ ok: true });

      const headers = getValidHeaders('123');
      const res = await request(app).post('/api/payments/webhook')
        .set(headers)
        .send({ type: 'payment', data: { id: '123' } });
      
      expect(res.status).toBe(200);
      expect(res.body.paymentStatus).toBe('approved');
      expect(res.body.reconciliationStatus).toBe('approved');
      expect(saveTransaction).toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should handle webhook error', async () => {
      getPaymentById.mockRejectedValueOnce(new Error('MP fetch failed'));
      const headers = getValidHeaders('123');
      const res = await request(app).post('/api/payments/webhook')
        .set(headers)
        .send({ type: 'payment', data: { id: '123' } });
      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/payments/:paymentId', () => {
    it('should return 404 if not found', async () => {
      getTransactionByPaymentId.mockResolvedValueOnce(null);
      const res = await request(app).get('/api/payments/123');
      expect(res.status).toBe(404);
    });

    it('should return transaction if found', async () => {
      getTransactionByPaymentId.mockResolvedValueOnce({ id: 'txn_1' });
      const res = await request(app).get('/api/payments/123');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'txn_1' });
    });
  });

  describe('GET /api/payments/external-reference/:externalReference', () => {
    it('should return 404 if not found', async () => {
      getTransactionByExternalReference.mockResolvedValueOnce(null);
      const res = await request(app).get('/api/payments/external-reference/ext_1');
      expect(res.status).toBe(404);
    });

    it('should return transaction if found', async () => {
      getTransactionByExternalReference.mockResolvedValueOnce({ id: 'txn_1' });
      const res = await request(app).get('/api/payments/external-reference/ext_1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'txn_1' });
    });
  });

  describe('POST /api/payments/verify-status', () => {
    it('should return 400 if neither externalReference nor paymentId is provided', async () => {
      const res = await request(app).post('/api/payments/verify-status').send({});
      expect(res.status).toBe(400);
    });

    it('should verify status using paymentId when transaction exists', async () => {
      getTransactionByPaymentId.mockResolvedValueOnce({ payment_id: '123', status: 'approved' });
      getPaymentById.mockResolvedValueOnce({ id: '123', status: 'approved' });

      const res = await request(app).post('/api/payments/verify-status').send({ paymentId: '123' });
      expect(res.status).toBe(200);
      expect(res.body.currentStatus).toBe('approved');
      expect(res.body.needsReconciliation).toBe(true);
    });

    it('should verify status and save transaction if not in DB', async () => {
      getTransactionByPaymentId.mockResolvedValueOnce(null);
      getPaymentById.mockResolvedValueOnce({ id: '123', status: 'pending' });
      saveTransaction.mockResolvedValueOnce({ status: 'pending' });

      const res = await request(app).post('/api/payments/verify-status').send({ paymentId: '123' });
      expect(res.status).toBe(200);
      expect(res.body.currentStatus).toBe('pending');
      expect(saveTransaction).toHaveBeenCalled();
    });

    it('should return 404 if payment not found anywhere', async () => {
      getTransactionByPaymentId.mockResolvedValueOnce(null);
      getPaymentById.mockResolvedValueOnce(null); // or throw error
      const res = await request(app).post('/api/payments/verify-status').send({ paymentId: '123' });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/payments/metrics', () => {
    let adminToken;
    beforeAll(async () => {
      const jwt = (await import('jsonwebtoken')).default;
      adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET);
    });

    it('should fetch totalAmount without dates', async () => {
      getTotalTransactionAmount.mockResolvedValueOnce(500);
      const res = await request(app).get('/api/payments/metrics').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ totalAmount: 500 });
    });

    it('should fetch totalAmount with dates', async () => {
      getTransactionAmountByPeriod.mockResolvedValueOnce(300);
      const res = await request(app).get('/api/payments/metrics').query({ from: '2023-01-01', to: '2023-12-31' }).set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ totalAmount: 300 });
    });

    it('should handle errors', async () => {
      getTotalTransactionAmount.mockRejectedValueOnce(new Error('DB error'));
      const res = await request(app).get('/api/payments/metrics').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(500);
    });
  });
});

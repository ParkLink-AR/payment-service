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
  claimTransactionForRefund: jest.fn(),
  markTransactionAsRefundedByPaymentId: jest.fn(),
  markTransactionAsRefundFailed: jest.fn()
}));

jest.unstable_mockModule('../src/bookingClient.js', () => ({
  getBooking: jest.fn(),
  confirmBooking: jest.fn()
}));

jest.unstable_mockModule('../src/mercadoPago.js', () => ({
  createCheckoutPreference: jest.fn(),
  getPaymentById: jest.fn(),
  refundPayment: jest.fn(),
  searchPaymentByExternalReference: jest.fn()
}));

const {
  pool,
  getTransactionByExternalReference,
  getTransactionByPaymentId,
  saveTransaction,
  getTotalTransactionAmount,
  getTransactionAmountByPeriod,
  claimTransactionForRefund,
  markTransactionAsRefundedByPaymentId,
  markTransactionAsRefundFailed
} = await import('../src/db.js');

const { getBooking, confirmBooking } = await import('../src/bookingClient.js');

const {
  createCheckoutPreference,
  getPaymentById,
  refundPayment,
  searchPaymentByExternalReference
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

  describe('GET /payment-return', () => {
    it('redirects to the pending screen with the bookingId, regardless of the status Mercado Pago reports', async () => {
      const res = await request(app).get('/payment-return').query({
        status: 'success',
        external_reference: 'booking-123',
        collection_status: 'approved',
      });

      expect(res.status).toBe(200);
      expect(res.text).toContain('parklink://payment/pending?bookingId=booking-123');
    });

    it('still redirects when there is no bookingId to attach', async () => {
      const res = await request(app).get('/payment-return').query({ status: 'failure' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('parklink://payment/pending');
      expect(res.text).not.toContain('bookingId=');
    });
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
      expect(res.body).toEqual({ status: 'error' });
    });
  });

  const DRIVER_ID = 'driver-1';
  const ownBooking = (overrides = {}) => ({
    id: 'booking-1',
    user_id: DRIVER_ID,
    status: 'PENDING_PAYMENT',
    amount: 150000,
    hold_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...overrides,
  });

  describe('POST /api/payments/create-preference', () => {
    it('requires an externalReference (the bookingId)', async () => {
      const res = await request(app).post('/api/payments/create-preference').set('x-user-id', DRIVER_ID).send({});
      expect(res.status).toBe(400);
    });

    it('rejects a booking that belongs to someone else', async () => {
      getBooking.mockResolvedValueOnce(ownBooking({ user_id: 'someone-else' }));
      const res = await request(app)
        .post('/api/payments/create-preference')
        .set('x-user-id', DRIVER_ID)
        .send({ externalReference: 'booking-1' });
      expect(res.status).toBe(403);
      expect(createCheckoutPreference).not.toHaveBeenCalled();
    });

    it('rejects a booking whose hold already expired', async () => {
      getBooking.mockResolvedValueOnce(ownBooking({ hold_expires_at: new Date(Date.now() - 1000).toISOString() }));
      const res = await request(app)
        .post('/api/payments/create-preference')
        .set('x-user-id', DRIVER_ID)
        .send({ externalReference: 'booking-1' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('HOLD_EXPIRED');
    });

    it('charges the booking\'s server-side price, ignoring any amount the client sends', async () => {
      const booking = ownBooking();
      getBooking.mockResolvedValueOnce(booking);
      createCheckoutPreference.mockResolvedValueOnce({ id: 'pref_123', init_point: 'https://mp.com/checkout/123' });

      const res = await request(app)
        .post('/api/payments/create-preference')
        .set('x-user-id', DRIVER_ID)
        .send({ externalReference: 'booking-1', amount: 1, items: [{ title: 'x', unit_price: 1 }] });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ preferenceId: 'pref_123', checkoutUrl: 'https://mp.com/checkout/123', externalReference: 'booking-1' });
      expect(createCheckoutPreference).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 1500, externalReference: 'booking-1', expiresAt: booking.hold_expires_at }),
      );
    });

    it('should handle internal errors', async () => {
      getBooking.mockResolvedValueOnce(ownBooking());
      createCheckoutPreference.mockRejectedValueOnce(new Error('MP Error'));
      const res = await request(app)
        .post('/api/payments/create-preference')
        .set('x-user-id', DRIVER_ID)
        .send({ externalReference: 'booking-1' });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ message: 'Error creating Mercado Pago preference' });
    });

    it('points back_urls at this service\'s own /payment-return bridge, not directly at the app deep link', async () => {
      getBooking.mockResolvedValueOnce(ownBooking());
      createCheckoutPreference.mockResolvedValueOnce({ id: 'pref_123', init_point: 'https://mp.com/checkout/123' });

      await request(app).post('/api/payments/create-preference').set('x-user-id', DRIVER_ID).send({ externalReference: 'booking-1' });

      expect(createCheckoutPreference).toHaveBeenCalledWith(
        expect.objectContaining({
          backUrls: {
            success: 'http://localhost:8004/payment-return?status=success',
            failure: 'http://localhost:8004/payment-return?status=failure',
            pending: 'http://localhost:8004/payment-return?status=pending',
          },
        }),
      );
    });
  });

  describe('POST /api/payments/webhook', () => {
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

    const approvedPayment = { id: '123', status: 'approved', external_reference: 'booking-uuid-123', transaction_amount: 1500 };

    it('should ignore if missing paymentId', async () => {
      const headers = getValidHeaders('none');
      const res = await request(app).post('/api/payments/webhook')
        .set(headers)
        .send({ type: 'other_topic', data: { id: 'none' } });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Webhook ignored');
    });

    it('confirms the booking with the amount actually charged, in centavos', async () => {
      getPaymentById.mockResolvedValueOnce(approvedPayment);
      saveTransaction.mockResolvedValueOnce({ id: 'txn_123', external_reference: 'booking-uuid-123' });
      confirmBooking.mockResolvedValueOnce({ ok: true, status: 200, code: null });

      const res = await request(app).post('/api/payments/webhook')
        .set(getValidHeaders('123'))
        .send({ type: 'payment', data: { id: '123' } });

      expect(res.status).toBe(200);
      expect(res.body.paymentStatus).toBe('approved');
      expect(res.body.bookingId).toBe('booking-uuid-123');
      expect(confirmBooking).toHaveBeenCalledWith('booking-uuid-123', '123', 150000);
      expect(refundPayment).not.toHaveBeenCalled();
    });

    it('refunds a payment booking-service refuses because the hold expired', async () => {
      getPaymentById.mockResolvedValueOnce(approvedPayment);
      saveTransaction.mockResolvedValueOnce({ id: 'txn_123' });
      confirmBooking.mockResolvedValueOnce({ ok: false, status: 400, code: 'HOLD_EXPIRED' });
      claimTransactionForRefund.mockResolvedValueOnce(true);
      refundPayment.mockResolvedValueOnce({ status: 'approved' });

      const res = await request(app).post('/api/payments/webhook')
        .set(getValidHeaders('123'))
        .send({ type: 'payment', data: { id: '123' } });

      expect(res.status).toBe(200);
      expect(refundPayment).toHaveBeenCalledWith('123');
      expect(markTransactionAsRefundedByPaymentId).toHaveBeenCalledWith('123');
    });

    it('does not refund twice when another path already claimed the refund', async () => {
      getPaymentById.mockResolvedValueOnce(approvedPayment);
      saveTransaction.mockResolvedValueOnce({ id: 'txn_123' });
      confirmBooking.mockResolvedValueOnce({ ok: false, status: 400, code: 'AMOUNT_MISMATCH' });
      claimTransactionForRefund.mockResolvedValueOnce(false);

      await request(app).post('/api/payments/webhook')
        .set(getValidHeaders('123'))
        .send({ type: 'payment', data: { id: '123' } });

      expect(refundPayment).not.toHaveBeenCalled();
    });

    it('flags the automatic refund for retry when Mercado Pago fails it', async () => {
      getPaymentById.mockResolvedValueOnce(approvedPayment);
      saveTransaction.mockResolvedValueOnce({ id: 'txn_123' });
      confirmBooking.mockResolvedValueOnce({ ok: false, status: 400, code: 'HOLD_EXPIRED' });
      claimTransactionForRefund.mockResolvedValueOnce(true);
      refundPayment.mockRejectedValueOnce(new Error('MP down'));

      await request(app).post('/api/payments/webhook')
        .set(getValidHeaders('123'))
        .send({ type: 'payment', data: { id: '123' } });

      expect(markTransactionAsRefundFailed).toHaveBeenCalledWith('123');
      expect(markTransactionAsRefundedByPaymentId).not.toHaveBeenCalled();
    });

    it('does not refund on a transient booking-service failure', async () => {
      getPaymentById.mockResolvedValueOnce(approvedPayment);
      saveTransaction.mockResolvedValueOnce({ id: 'txn_123' });
      confirmBooking.mockResolvedValueOnce({ ok: false, status: 502, code: 'PARKING_SERVICE_ERROR' });

      await request(app).post('/api/payments/webhook')
        .set(getValidHeaders('123'))
        .send({ type: 'payment', data: { id: '123' } });

      expect(claimTransactionForRefund).not.toHaveBeenCalled();
    });

    it('should handle webhook error without leaking internals', async () => {
      getPaymentById.mockRejectedValueOnce(new Error('MP fetch failed'));
      const res = await request(app).post('/api/payments/webhook')
        .set(getValidHeaders('123'))
        .send({ type: 'payment', data: { id: '123' } });
      expect(res.status).toBe(500);
      expect(res.body.detail).toBeUndefined();
    });
  });

  describe('GET /api/payments/:paymentId', () => {
    let adminToken;
    beforeAll(async () => {
      const jwt = (await import('jsonwebtoken')).default;
      adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET);
    });

    it('is staff-only', async () => {
      const res = await request(app).get('/api/payments/123');
      expect(res.status).toBe(401);
      expect(getTransactionByPaymentId).not.toHaveBeenCalled();
    });

    it('should return 404 if not found', async () => {
      getTransactionByPaymentId.mockResolvedValueOnce(null);
      const res = await request(app).get('/api/payments/123').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
    });

    it('should return transaction if found', async () => {
      getTransactionByPaymentId.mockResolvedValueOnce({ id: 'txn_1' });
      const res = await request(app).get('/api/payments/123').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'txn_1' });
    });
  });

  describe('GET /api/payments/external-reference/:externalReference', () => {
    let adminToken;
    beforeAll(async () => {
      const jwt = (await import('jsonwebtoken')).default;
      adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET);
    });

    it('is staff-only', async () => {
      const res = await request(app).get('/api/payments/external-reference/ext_1');
      expect(res.status).toBe(401);
    });

    it('should return transaction if found', async () => {
      getTransactionByExternalReference.mockResolvedValueOnce({ id: 'txn_1' });
      const res = await request(app)
        .get('/api/payments/external-reference/ext_1')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'txn_1' });
    });
  });

  describe('POST /api/payments/verify-status', () => {
    const verify = (body) => request(app).post('/api/payments/verify-status').set('x-user-id', DRIVER_ID).send(body);

    it('requires an externalReference', async () => {
      const res = await verify({});
      expect(res.status).toBe(400);
    });

    it('ignores a client-supplied Mercado Pago payment id', async () => {
      const res = await verify({ paymentId: 'mock-approved-1-1500-booking-1' });
      expect(res.status).toBe(400);
      expect(getPaymentById).not.toHaveBeenCalled();
    });

    it('rejects polling someone else\'s booking', async () => {
      getBooking.mockResolvedValueOnce(ownBooking({ user_id: 'someone-else' }));
      const res = await verify({ externalReference: 'booking-1' });
      expect(res.status).toBe(403);
      expect(getTransactionByExternalReference).not.toHaveBeenCalled();
    });

    it('returns the stored payment\'s current status', async () => {
      getBooking.mockResolvedValueOnce(ownBooking());
      getTransactionByExternalReference.mockResolvedValueOnce({ payment_id: '123', status: 'pending' });
      getPaymentById.mockResolvedValueOnce({ id: '123', status: 'pending' });

      const res = await verify({ externalReference: 'booking-1' });
      expect(res.status).toBe(200);
      expect(res.body.currentStatus).toBe('pending');
      expect(confirmBooking).not.toHaveBeenCalled();
    });

    it('falls back to searching MP by externalReference when nothing is in the DB (no webhook)', async () => {
      getBooking.mockResolvedValueOnce(ownBooking());
      getTransactionByExternalReference.mockResolvedValueOnce(null);
      searchPaymentByExternalReference.mockResolvedValueOnce({
        id: 'mp-1', status: 'approved', external_reference: 'booking-1', transaction_amount: 1500,
      });
      saveTransaction.mockResolvedValueOnce({ status: 'approved', external_reference: 'booking-1' });
      confirmBooking.mockResolvedValueOnce({ ok: true, status: 200, code: null });

      const res = await verify({ externalReference: 'booking-1' });

      expect(res.status).toBe(200);
      expect(res.body.currentStatus).toBe('approved');
      expect(searchPaymentByExternalReference).toHaveBeenCalledWith('booking-1');
      expect(confirmBooking).toHaveBeenCalledWith('booking-1', 'mp-1', 150000);
    });

    it('returns 404 when the MP search fallback also finds nothing', async () => {
      getBooking.mockResolvedValueOnce(ownBooking());
      getTransactionByExternalReference.mockResolvedValueOnce(null);
      searchPaymentByExternalReference.mockResolvedValueOnce(null);

      const res = await verify({ externalReference: 'booking-1' });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/payments/refund-status/:bookingId', () => {
    const refundStatus = (userId) =>
      request(app).get('/api/payments/refund-status/booking-1').set('x-user-id', userId);

    it('reports a completed refund with its amount and date', async () => {
      getBooking.mockResolvedValueOnce(ownBooking({ status: 'CANCELLED' }));
      getTransactionByExternalReference.mockResolvedValueOnce({
        status: 'refunded', amount: '1500.00', updated_at: '2026-10-05T12:00:00Z',
      });
      const res = await refundStatus(DRIVER_ID);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'refunded', amount: 1500, refundedAt: '2026-10-05T12:00:00Z' });
    });

    it('reports a refund that failed and is being retried as still in progress', async () => {
      getBooking.mockResolvedValueOnce(ownBooking({ status: 'CANCELLED' }));
      getTransactionByExternalReference.mockResolvedValueOnce({ status: 'refund_failed', refund_attempts: 1, amount: '1500.00' });
      const res = await refundStatus(DRIVER_ID);
      expect(res.body.status).toBe('in_progress');
    });

    it('reports a refund that exhausted its automatic retries as delayed', async () => {
      getBooking.mockResolvedValueOnce(ownBooking({ status: 'CANCELLED' }));
      getTransactionByExternalReference.mockResolvedValueOnce({ status: 'refund_failed', refund_attempts: 5, amount: '1500.00' });
      const res = await refundStatus(DRIVER_ID);
      expect(res.body.status).toBe('delayed');
    });

    it('is only for the booking\'s own driver', async () => {
      getBooking.mockResolvedValueOnce(ownBooking({ user_id: 'someone-else' }));
      const res = await refundStatus(DRIVER_ID);
      expect(res.status).toBe(403);
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

  describe('POST /api/payments/demo-pay', () => {
    let adminToken;
    beforeAll(async () => {
      const jwt = (await import('jsonwebtoken')).default;
      adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET);
    });

    it('requires an admin token', async () => {
      const res = await request(app).post('/api/payments/demo-pay').send({ bookingId: 'b1' });
      expect(res.status).toBe(401);
      expect(saveTransaction).not.toHaveBeenCalled();
    });

    it('marks the booking as paid for an admin, at the booking\'s own price', async () => {
      getBooking.mockResolvedValueOnce({ id: 'b1', user_id: 'd1', status: 'PENDING_PAYMENT', amount: 150000 });
      confirmBooking.mockResolvedValueOnce({ ok: true, status: 200, code: null });
      saveTransaction.mockResolvedValueOnce({ id: 'tx1' });

      const res = await request(app)
        .post('/api/payments/demo-pay')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bookingId: 'b1' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('approved');
      expect(confirmBooking).toHaveBeenCalledWith('b1', expect.stringMatching(/^demo-/), 150000);
    });
  });

  describe('POST /internal/refund-by-payment', () => {
    it('requires the internal key', async () => {
      const res = await request(app).post('/internal/refund-by-payment').send({ payment_id: 'pay1' });
      expect(res.status).toBe(401);
      expect(refundPayment).not.toHaveBeenCalled();
    });

    it('refunds via Mercado Pago and marks the transaction refunded for a valid key', async () => {
      refundPayment.mockResolvedValueOnce({ id: 'pay1', status: 'refunded' });
      markTransactionAsRefundedByPaymentId.mockResolvedValueOnce();

      const res = await request(app)
        .post('/internal/refund-by-payment')
        .set('X-Internal-Key', process.env.INTERNAL_SERVICE_KEY)
        .send({ payment_id: 'pay1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(refundPayment).toHaveBeenCalledWith('pay1');
      expect(markTransactionAsRefundedByPaymentId).toHaveBeenCalledWith('pay1');
    });

    it('flags the transaction for manual review when a real Mercado Pago refund fails, instead of marking it refunded', async () => {
      // refundPayment() itself already no-ops for known-fake ids (mock-/
      // seed-demo- prefixes, see mercadoPago.test.js) -- a rejection
      // reaching this handler means a real payment genuinely failed to
      // refund, so it must NOT be reported as success.
      refundPayment.mockRejectedValueOnce(new Error('Unauthorized use of live credentials'));
      markTransactionAsRefundFailed.mockResolvedValueOnce();

      const res = await request(app)
        .post('/internal/refund-by-payment')
        .set('X-Internal-Key', process.env.INTERNAL_SERVICE_KEY)
        .send({ payment_id: '178591399221' });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({
        success: false,
        detail: 'Mercado Pago refund failed; transaction flagged for manual review',
      });
      expect(markTransactionAsRefundFailed).toHaveBeenCalledWith('178591399221');
      expect(markTransactionAsRefundedByPaymentId).not.toHaveBeenCalled();
    });
  });
});

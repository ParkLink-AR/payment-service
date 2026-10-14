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
  addPartialRefund: jest.fn(),
  listTransactions: jest.fn(),
  markTransactionAsRefundFailed: jest.fn(),
  listFailedRefunds: jest.fn(),
  countFailedRefunds: jest.fn(),
  claimFailedRefundForRetry: jest.fn(),
  resolveFailedRefund: jest.fn()
}));

const announceRefundCompleted = jest.fn();
jest.unstable_mockModule('../src/events.js', () => ({ announceRefundCompleted }));

jest.unstable_mockModule('../src/bookingClient.js', () => ({
  getBooking: jest.fn(),
  confirmBooking: jest.fn()
}));

jest.unstable_mockModule('../src/mercadoPago.js', () => ({
  createCheckoutPreference: jest.fn(),
  getPaymentById: jest.fn(),
  refundPayment: jest.fn(),
  searchPaymentByExternalReference: jest.fn(),
  // The real classification is covered in mercadoPago.test.js; here every failure reads
  // as a test-user payment.
  describeRefundError: jest.fn(() => ({ code: 'test_payment', permanent: true, detail: 'Unauthorized use of live credentials' }))
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
  addPartialRefund,
  listTransactions,
  markTransactionAsRefundFailed,
  listFailedRefunds,
  countFailedRefunds,
  claimFailedRefundForRetry,
  resolveFailedRefund
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

      expect(markTransactionAsRefundFailed).toHaveBeenCalledWith('123', expect.objectContaining({ code: 'test_payment' }), 5);
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

    it('picks up a newer attempt after a rejected one (the driver went back to the checkout)', async () => {
      getBooking.mockResolvedValueOnce(ownBooking());
      getTransactionByExternalReference.mockResolvedValueOnce({ payment_id: 'mp-old', status: 'rejected' });
      getPaymentById.mockResolvedValueOnce({ id: 'mp-old', status: 'rejected' });
      searchPaymentByExternalReference.mockResolvedValueOnce({
        id: 'mp-new', status: 'approved', external_reference: 'booking-1', transaction_amount: 1500,
      });
      saveTransaction.mockResolvedValueOnce({ payment_id: 'mp-new', status: 'approved' });
      confirmBooking.mockResolvedValueOnce({ ok: true, status: 200, code: null });

      const res = await verify({ externalReference: 'booking-1' });

      expect(res.body.currentStatus).toBe('approved');
      expect(confirmBooking).toHaveBeenCalledWith('booking-1', 'mp-new', 150000);
    });

    it('keeps reporting a rejected attempt while there is no newer one', async () => {
      getBooking.mockResolvedValueOnce(ownBooking());
      getTransactionByExternalReference.mockResolvedValueOnce({ payment_id: 'mp-old', status: 'rejected' });
      getPaymentById.mockResolvedValueOnce({ id: 'mp-old', status: 'rejected' });
      searchPaymentByExternalReference.mockResolvedValueOnce({ id: 'mp-old', status: 'rejected' });

      const res = await verify({ externalReference: 'booking-1' });

      expect(res.body.currentStatus).toBe('rejected');
      expect(saveTransaction).not.toHaveBeenCalled();
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

    it('reports a refund an admin returned by hand as refunded, dated when they closed it', async () => {
      getBooking.mockResolvedValueOnce(ownBooking());
      getTransactionByExternalReference.mockResolvedValueOnce({
        status: 'refunded_manually', amount: '1500.00', updated_at: '2026-10-09T10:00:00Z', refund_resolved_at: '2026-10-09T09:00:00Z',
      });
      const res = await refundStatus(DRIVER_ID);
      expect(res.body).toEqual({ status: 'refunded', amount: 1500, refundedAt: '2026-10-09T09:00:00Z' });
    });

    it('reports a discarded refund (nothing owed, e.g. test data) as no refund', async () => {
      getBooking.mockResolvedValueOnce(ownBooking());
      getTransactionByExternalReference.mockResolvedValueOnce({ status: 'refund_discarded', amount: '1500.00' });
      const res = await refundStatus(DRIVER_ID);
      expect(res.body.status).toBe('none');
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

    it('gives back only part of the payment when an admin asked for it (centavos -> pesos)', async () => {
      refundPayment.mockResolvedValueOnce({ id: 'pay1', status: 'approved' });
      addPartialRefund.mockResolvedValueOnce();

      const res = await request(app)
        .post('/internal/refund-by-payment')
        .set('X-Internal-Key', process.env.INTERNAL_SERVICE_KEY)
        .send({ payment_id: 'pay1', amount_centavos: 250050 });

      expect(res.status).toBe(200);
      expect(refundPayment).toHaveBeenCalledWith('pay1', 2500.5);
      expect(addPartialRefund).toHaveBeenCalledWith('pay1', 2500.5);
      expect(markTransactionAsRefundedByPaymentId).not.toHaveBeenCalled();
    });

    it('reports a failed partial refund instead of queueing it (the retry job only refunds in full)', async () => {
      refundPayment.mockRejectedValueOnce(new Error('boom'));

      const res = await request(app)
        .post('/internal/refund-by-payment')
        .set('X-Internal-Key', process.env.INTERNAL_SERVICE_KEY)
        .send({ payment_id: 'pay1', amount_centavos: 1000 });

      expect(res.status).toBe(502);
      expect(markTransactionAsRefundFailed).not.toHaveBeenCalled();
      expect(addPartialRefund).not.toHaveBeenCalled();
    });

    it('accepts a refund Mercado Pago fails as owed (202), flagging it with why, instead of marking it refunded', async () => {
      // refundPayment() itself already no-ops for known-fake ids (mock-/seed-demo- prefixes,
      // see mercadoPago.test.js) -- a rejection reaching this handler means a real payment
      // failed to refund. The cancellation that asked for it went through, so it's not an
      // error for booking-service: the refund is on record for the retry job and the admin.
      refundPayment.mockRejectedValueOnce(new Error('Unauthorized use of live credentials'));
      markTransactionAsRefundFailed.mockResolvedValueOnce(true);

      const res = await request(app)
        .post('/internal/refund-by-payment')
        .set('X-Internal-Key', process.env.INTERNAL_SERVICE_KEY)
        .send({ payment_id: '178591399221' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ success: false, queued: true, code: 'test_payment' });
      expect(markTransactionAsRefundFailed).toHaveBeenCalledWith(
        '178591399221', expect.objectContaining({ code: 'test_payment', permanent: true }), 5,
      );
      expect(markTransactionAsRefundedByPaymentId).not.toHaveBeenCalled();
    });

    it('still fails (502) when there is no transaction to flag, so nobody would follow up', async () => {
      refundPayment.mockRejectedValueOnce(new Error('MP down'));
      markTransactionAsRefundFailed.mockResolvedValueOnce(false);

      const res = await request(app)
        .post('/internal/refund-by-payment')
        .set('X-Internal-Key', process.env.INTERNAL_SERVICE_KEY)
        .send({ payment_id: 'unknown' });

      expect(res.status).toBe(502);
      expect(markTransactionAsRefundedByPaymentId).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/payments', () => {
    let adminToken;
    beforeAll(async () => {
      const jwt = (await import('jsonwebtoken')).default;
      adminToken = jwt.sign({ role: 'admin', sub: 'admin-1' }, process.env.JWT_SECRET);
    });

    it('is admin-only', async () => {
      const res = await request(app).get('/admin/payments');
      expect(res.status).toBe(401);
      expect(listTransactions).not.toHaveBeenCalled();
    });

    it("flags an approved payment whose booking never got paid on ParkLink's side", async () => {
      listTransactions.mockResolvedValueOnce({
        total: 2,
        rows: [
          { payment_id: 'p1', external_reference: 'b1', amount: '1500.00', refunded_amount: '0', status: 'approved' },
          { payment_id: 'p2', external_reference: 'b2', amount: '900.00', refunded_amount: '100', status: 'approved' },
        ],
      });
      getBooking.mockResolvedValueOnce({ id: 'b1', status: 'EXPIRED' }).mockResolvedValueOnce({ id: 'b2', status: 'COMPLETED' });

      const res = await request(app).get('/admin/payments?q=b&status=approved').set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.items.map((i) => [i.paymentId, i.needsAttention, i.refundedAmount])).toEqual([
        ['p1', true, 0],
        ['p2', false, 100],
      ]);
      expect(listTransactions).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved', query: 'b' }));
    });
  });

  describe('admin failed refunds', () => {
    let adminToken;
    let userToken;
    beforeAll(async () => {
      const jwt = (await import('jsonwebtoken')).default;
      adminToken = jwt.sign({ role: 'admin', sub: 'admin-1' }, process.env.JWT_SECRET);
      userToken = jwt.sign({ sub: 'user-1' }, process.env.JWT_SECRET);
    });
    const asAdmin = (req) => req.set('Authorization', `Bearer ${adminToken}`);

    it('is admin-only', async () => {
      const res = await request(app).get('/admin/refunds').set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(403);
      expect(listFailedRefunds).not.toHaveBeenCalled();
    });

    it('lists every refund still owed, with its booking and why it failed', async () => {
      listFailedRefunds.mockResolvedValueOnce([
        {
          payment_id: '182168894549', external_reference: 'booking-1', amount: '8640.00', currency: 'ARS',
          payer_email: 'driver@test.com', approved_at: '2026-10-08T20:00:00Z', refund_attempts: 5,
          refund_error_code: 'test_payment', refund_last_error: 'Unauthorized use of live credentials',
          updated_at: '2026-10-09T02:33:56Z',
        },
        {
          payment_id: '999', external_reference: 'booking-2', amount: '1000.00', currency: 'ARS',
          payer_email: null, approved_at: null, refund_attempts: 1,
          refund_error_code: 'transient', refund_last_error: 'timeout', updated_at: '2026-10-09T01:00:00Z',
        },
      ]);
      getBooking.mockImplementation((id) =>
        id === 'booking-1' ? Promise.resolve({ id: 'booking-1', user_id: 'driver-1' }) : Promise.reject(new Error('down')),
      );
      jest.spyOn(console, 'warn').mockImplementationOnce(() => {});

      const res = await asAdmin(request(app).get('/admin/refunds'));

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0]).toEqual({
        paymentId: '182168894549', bookingId: 'booking-1', amount: 8640, currency: 'ARS',
        payerEmail: 'driver@test.com', approvedAt: '2026-10-08T20:00:00Z', attempts: 5, retriesExhausted: true,
        errorCode: 'test_payment', lastError: 'Unauthorized use of live credentials', failedAt: '2026-10-09T02:33:56Z',
        booking: { id: 'booking-1', user_id: 'driver-1' },
      });
      // A booking that can't be loaded doesn't hide the refund.
      expect(res.body.items[1]).toEqual(expect.objectContaining({ paymentId: '999', booking: null, retriesExhausted: false }));
      getBooking.mockReset();
    });

    it('counts the refunds still owed', async () => {
      countFailedRefunds.mockResolvedValueOnce(3);
      const res = await asAdmin(request(app).get('/admin/refunds/count'));
      expect(res.body).toEqual({ count: 3 });
    });

    it('retries a refund now and marks it refunded when Mercado Pago accepts it', async () => {
      claimFailedRefundForRetry.mockResolvedValueOnce(true);
      refundPayment.mockResolvedValueOnce({ status: 'refunded' });

      const res = await asAdmin(request(app).post('/admin/refunds/pay1/retry'));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'refunded' });
      expect(markTransactionAsRefundedByPaymentId).toHaveBeenCalledWith('pay1');
      // The driver is told their money finally reached them.
      expect(announceRefundCompleted).toHaveBeenCalledWith('pay1', 'mercadopago');
    });

    it('keeps a retried refund flagged, with why, when Mercado Pago fails it again', async () => {
      claimFailedRefundForRetry.mockResolvedValueOnce(true);
      refundPayment.mockRejectedValueOnce(new Error('Unauthorized use of live credentials'));
      jest.spyOn(console, 'error').mockImplementationOnce(() => {});

      const res = await asAdmin(request(app).post('/admin/refunds/pay1/retry'));

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('test_payment');
      expect(markTransactionAsRefundFailed).toHaveBeenCalledWith('pay1', expect.objectContaining({ code: 'test_payment' }), 5);
      expect(markTransactionAsRefundedByPaymentId).not.toHaveBeenCalled();
    });

    it('does not retry a refund that is no longer pending (already retried or resolved)', async () => {
      claimFailedRefundForRetry.mockResolvedValueOnce(false);
      const res = await asAdmin(request(app).post('/admin/refunds/pay1/retry'));
      expect(res.status).toBe(409);
      expect(refundPayment).not.toHaveBeenCalled();
    });

    it('discards a refund with a note, recording who did it', async () => {
      resolveFailedRefund.mockResolvedValueOnce({ status: 'refund_discarded' });

      const res = await asAdmin(request(app).post('/admin/refunds/pay1/resolve'))
        .send({ resolution: 'discarded', note: 'Pago de prueba de Mercado Pago' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'refund_discarded' });
      expect(resolveFailedRefund).toHaveBeenCalledWith('pay1', 'refund_discarded', 'Pago de prueba de Mercado Pago', 'admin-1');
      // Nothing was owed: no notice to the driver.
      expect(announceRefundCompleted).not.toHaveBeenCalled();
    });

    it('requires a note to discard a refund', async () => {
      const res = await asAdmin(request(app).post('/admin/refunds/pay1/resolve')).send({ resolution: 'discarded', note: ' ' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NOTE_REQUIRED');
      expect(resolveFailedRefund).not.toHaveBeenCalled();
    });

    it('marks a refund as returned by hand, note optional', async () => {
      resolveFailedRefund.mockResolvedValueOnce({ status: 'refunded_manually' });
      const res = await asAdmin(request(app).post('/admin/refunds/pay1/resolve')).send({ resolution: 'refunded_manually' });
      expect(res.status).toBe(200);
      expect(resolveFailedRefund).toHaveBeenCalledWith('pay1', 'refunded_manually', null, 'admin-1');
      expect(announceRefundCompleted).toHaveBeenCalledWith('pay1', 'manual');
    });

    it('rejects an unknown resolution, including inherited object keys', async () => {
      for (const resolution of ['refunded', 'constructor', undefined]) {
        const res = await asAdmin(request(app).post('/admin/refunds/pay1/resolve')).send({ resolution, note: 'x x x' });
        expect(res.status).toBe(400);
      }
      expect(resolveFailedRefund).not.toHaveBeenCalled();
    });

    it('reports a refund that is no longer pending', async () => {
      resolveFailedRefund.mockResolvedValueOnce(null);
      const res = await asAdmin(request(app).post('/admin/refunds/pay1/resolve')).send({ resolution: 'refunded_manually' });
      expect(res.status).toBe(409);
    });
  });
});

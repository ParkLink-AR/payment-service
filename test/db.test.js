import { jest } from '@jest/globals';

jest.unstable_mockModule('pg', () => {
  const mPool = {
    query: jest.fn(),
  };
  return {
    default: {
      Pool: jest.fn(() => mPool),
    },
  };
});

let db;
let pool;

describe('DB Module', () => {
  beforeAll(async () => {
    const pg = await import('pg');
    db = await import('../src/db.js');
    pool = db.pool;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getTransactionByPaymentId', () => {
    it('should return transaction if found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ id: 1, payment_id: '123' }] });
      const result = await db.getTransactionByPaymentId('123');
      expect(result).toEqual({ id: 1, payment_id: '123' });
      expect(pool.query).toHaveBeenCalledWith(
        'SELECT * FROM transactions WHERE payment_id = $1',
        ['123']
      );
    });

    it('should return null if not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      const result = await db.getTransactionByPaymentId('123');
      expect(result).toBeNull();
    });
  });

  describe('getTransactionByExternalReference', () => {
    it('should return transaction if found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ id: 1, external_reference: 'ext_123' }] });
      const result = await db.getTransactionByExternalReference('ext_123');
      expect(result).toEqual({ id: 1, external_reference: 'ext_123' });
    });
  });

  describe('saveTransaction', () => {
    it('should insert or update transaction', async () => {
      const paymentData = {
        id: '123',
        status: 'approved',
        status_detail: 'accredited',
        transaction_amount: 100,
        currency_id: 'ARS',
        payment_method_id: 'visa',
        payment_type_id: 'credit_card',
        order: { id: 'ord_1' },
        external_reference: 'ext_123'
      };

      pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      const result = await db.saveTransaction(paymentData);
      expect(result).toEqual({ id: 1 });
      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTotalTransactionAmount', () => {
    it('should return total amount', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ total_amount: 500 }] });
      const result = await db.getTotalTransactionAmount();
      expect(result).toBe(500);
    });
    it('should return 0 if null', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ total_amount: 0 }] });
      const result = await db.getTotalTransactionAmount();
      expect(result).toBe(0);
    });
  });

  describe('getTransactionAmountByPeriod', () => {
    it('should return total amount for period', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ total_amount: 300 }] });
      const result = await db.getTransactionAmountByPeriod('2023-01-01', '2023-12-31');
      expect(result).toBe(300);
    });
  });

  describe('failed refunds', () => {
    it('flags a failed refund with why, and reports whether there was a transaction to flag', async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 1 });
      const tracked = await db.markTransactionAsRefundFailed('pay1', { code: 'transient', permanent: false, detail: 'timeout' }, 5);
      expect(tracked).toBe(true);
      expect(pool.query.mock.calls[0][1]).toEqual(['pay1', 'transient', false, 5, 'timeout']);

      pool.query.mockResolvedValueOnce({ rowCount: 0 });
      expect(await db.markTransactionAsRefundFailed('missing')).toBe(false);
      expect(pool.query.mock.calls[1][1]).toEqual(['missing', null, false, 0, null]);
    });

    it('jumps a permanent failure straight to the retry cutoff', async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 1 });
      await db.markTransactionAsRefundFailed('pay1', { code: 'test_payment', permanent: true, detail: 'live credentials' }, 5);
      expect(pool.query.mock.calls[0][0]).toContain('GREATEST(refund_attempts + 1, $4)');
      expect(pool.query.mock.calls[0][1][2]).toBe(true);
    });

    it('lists and counts only refunds still owed', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ payment_id: 'pay1' }] });
      expect(await db.listFailedRefunds()).toEqual([{ payment_id: 'pay1' }]);
      expect(pool.query.mock.calls[0][0]).toContain("status = 'refund_failed'");

      pool.query.mockResolvedValueOnce({ rows: [{ count: 2 }] });
      expect(await db.countFailedRefunds()).toBe(2);
    });

    it('claims a failed refund for a manual retry only while it is still failed', async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 1 });
      expect(await db.claimFailedRefundForRetry('pay1')).toBe(true);
      expect(pool.query.mock.calls[0][0]).toContain("status = 'refund_failed'");
      pool.query.mockResolvedValueOnce({ rowCount: 0 });
      expect(await db.claimFailedRefundForRetry('pay1')).toBe(false);
    });

    it('resolves a failed refund by hand with who, why and when', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ payment_id: 'pay1', status: 'refund_discarded' }] });
      const resolved = await db.resolveFailedRefund('pay1', 'refund_discarded', 'test data', 'admin-1');
      expect(resolved).toEqual({ payment_id: 'pay1', status: 'refund_discarded' });
      expect(pool.query.mock.calls[0][1]).toEqual(['pay1', 'refund_discarded', 'test data', 'admin-1']);

      pool.query.mockResolvedValueOnce({ rows: [] });
      expect(await db.resolveFailedRefund('pay1', 'refund_discarded', 'x', 'admin-1')).toBeNull();
    });
  });
});

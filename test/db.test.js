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
});

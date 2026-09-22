import { jest } from '@jest/globals';

const listRefundFailedTransactions = jest.fn();
const markTransactionAsRefundedByPaymentId = jest.fn();
const markTransactionAsRefundFailed = jest.fn();
const refundPayment = jest.fn();

jest.unstable_mockModule('../src/db.js', () => ({
  listRefundFailedTransactions,
  markTransactionAsRefundedByPaymentId,
  markTransactionAsRefundFailed,
}));

jest.unstable_mockModule('../src/mercadoPago.js', () => ({
  refundPayment,
}));

let job;

describe('refundRetryJob', () => {
  beforeAll(async () => {
    job = await import('../src/refundRetryJob.js');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Quiet expected console.error noise from the intentional-failure test cases below.
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('retryFailedRefunds', () => {
    it('does nothing when there are no refund_failed transactions', async () => {
      listRefundFailedTransactions.mockResolvedValueOnce([]);

      const count = await job.retryFailedRefunds();

      expect(count).toBe(0);
      expect(refundPayment).not.toHaveBeenCalled();
    });

    it('marks a transaction refunded once the retried refund succeeds', async () => {
      listRefundFailedTransactions.mockResolvedValueOnce([{ payment_id: 'pay_1', refund_attempts: 1 }]);
      refundPayment.mockResolvedValueOnce({ status: 'refunded' });

      await job.retryFailedRefunds();

      expect(refundPayment).toHaveBeenCalledWith('pay_1');
      expect(markTransactionAsRefundedByPaymentId).toHaveBeenCalledWith('pay_1');
      expect(markTransactionAsRefundFailed).not.toHaveBeenCalled();
    });

    it('leaves a transaction flagged (with a bumped attempt count) when the retry fails too', async () => {
      listRefundFailedTransactions.mockResolvedValueOnce([{ payment_id: 'pay_2', refund_attempts: 2 }]);
      refundPayment.mockRejectedValueOnce(new Error('Mercado Pago is down'));

      await job.retryFailedRefunds();

      expect(markTransactionAsRefundFailed).toHaveBeenCalledWith('pay_2');
      expect(markTransactionAsRefundedByPaymentId).not.toHaveBeenCalled();
    });

    it('processes every pending transaction independently -- one failure does not stop the rest', async () => {
      listRefundFailedTransactions.mockResolvedValueOnce([
        { payment_id: 'pay_ok', refund_attempts: 0 },
        { payment_id: 'pay_bad', refund_attempts: 0 },
      ]);
      refundPayment.mockImplementation((paymentId) =>
        paymentId === 'pay_bad' ? Promise.reject(new Error('nope')) : Promise.resolve({ status: 'refunded' })
      );

      const count = await job.retryFailedRefunds();

      expect(count).toBe(2);
      expect(markTransactionAsRefundedByPaymentId).toHaveBeenCalledWith('pay_ok');
      expect(markTransactionAsRefundFailed).toHaveBeenCalledWith('pay_bad');
    });
  });

  describe('startRefundRetryJob', () => {
    it('ticks retryFailedRefunds on the configured interval', async () => {
      jest.useFakeTimers();
      listRefundFailedTransactions.mockResolvedValue([]);

      const handle = job.startRefundRetryJob();
      // config.refundRetryIntervalMinutes defaults to 30 when unset (see config.js).
      await jest.advanceTimersByTimeAsync(30 * 60_000);

      expect(listRefundFailedTransactions).toHaveBeenCalledTimes(1);
      clearInterval(handle);
      jest.useRealTimers();
    });
  });
});

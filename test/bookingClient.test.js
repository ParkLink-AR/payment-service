import { jest } from '@jest/globals';

const { getBooking, getBookingDebts, confirmBooking } = await import('../src/bookingClient.js');

describe('bookingClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  describe('getBookingDebts', () => {
    it('asks booking-service, with the internal key, for the balances the booking\'s payment includes', async () => {
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ debts: [{ amount: 6000, minutes: 20 }] }) });

      const debts = await getBookingDebts('b 1');

      expect(debts).toEqual([{ amount: 6000, minutes: 20 }]);
      const [url, options] = global.fetch.mock.calls[0];
      expect(url).toMatch(/\/internal\/bookings\/b%201\/debts$/);
      expect(options.headers['X-Internal-Key']).toBe(process.env.INTERNAL_SERVICE_KEY);
    });

    it('is an empty list when the response has none', async () => {
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      expect(await getBookingDebts('b1')).toEqual([]);
    });

    it('throws when booking-service fails, so the caller can fall back', async () => {
      global.fetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(getBookingDebts('b1')).rejects.toThrow('booking-service responded 500');
    });
  });

  describe('getBooking', () => {
    it('gives back the booking with its debt_amount', async () => {
      global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'b1', amount: 1000, debt_amount: 600 }) });

      expect(await getBooking('b1')).toEqual({ id: 'b1', amount: 1000, debt_amount: 600 });
    });

    it('is null for a booking that does not exist', async () => {
      global.fetch.mockResolvedValueOnce({ ok: false, status: 404 });

      expect(await getBooking('b1')).toBeNull();
    });
  });

  describe('confirmBooking', () => {
    it('sends the total that was charged', async () => {
      global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const result = await confirmBooking('b1', 123, 160000);

      expect(result).toEqual({ ok: true, status: 200, code: null });
      expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ payment_id: '123', amount: 160000 });
    });

    it('reports the code booking-service refused with', async () => {
      global.fetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ code: 'AMOUNT_MISMATCH' }) });

      expect(await confirmBooking('b1', 123, 1)).toEqual({ ok: false, status: 400, code: 'AMOUNT_MISMATCH' });
    });
  });
});

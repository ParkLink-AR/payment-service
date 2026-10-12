import { jest } from '@jest/globals';

const publish = jest.fn();
const assertExchange = jest.fn().mockResolvedValue({});
const connect = jest.fn().mockResolvedValue({
  on: jest.fn(),
  createChannel: jest.fn().mockResolvedValue({ assertExchange, publish }),
});
jest.unstable_mockModule('amqplib', () => ({ default: { connect } }));

const getTransactionByPaymentId = jest.fn();
jest.unstable_mockModule('../src/db.js', () => ({ getTransactionByPaymentId }));
const getBooking = jest.fn();
jest.unstable_mockModule('../src/bookingClient.js', () => ({ getBooking }));

const { announceRefundCompleted } = await import('../src/events.js');

describe('announceRefundCompleted', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RABBITMQ_URL = 'amqp://test';
  });

  it("publishes refund.completed to the booking's driver with the amount in centavos", async () => {
    getTransactionByPaymentId.mockResolvedValueOnce({ payment_id: 'pay1', external_reference: 'booking-1', amount: '8640.00' });
    getBooking.mockResolvedValueOnce({ id: 'booking-1', user_id: 'driver-1', parking_spot_id: 'spot-1' });

    await announceRefundCompleted('pay1', 'manual');

    expect(publish).toHaveBeenCalledTimes(1);
    const [exchange, routingKey, body] = publish.mock.calls[0];
    expect(exchange).toBe('parklink.events');
    expect(routingKey).toBe('refund.completed');
    expect(JSON.parse(body.toString())).toEqual(expect.objectContaining({
      event_type: 'refund.completed',
      booking_id: 'booking-1',
      parking_spot_id: 'spot-1',
      driver_user_id: 'driver-1',
      amount: 864000,
      method: 'manual',
    }));
  });

  it('publishes nothing when the payment has no booking to tell anyone about', async () => {
    getTransactionByPaymentId.mockResolvedValueOnce({ payment_id: 'pay1', external_reference: null, amount: '1.00' });

    await announceRefundCompleted('pay1', 'mercadopago');

    expect(publish).not.toHaveBeenCalled();
  });

  it('never throws when the lookup fails', async () => {
    getTransactionByPaymentId.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementationOnce(() => {});

    await expect(announceRefundCompleted('pay1', 'manual')).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });
});

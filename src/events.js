// Publishes payment-service's domain events (e.g. `refund.completed`) to the shared
// `parklink.events` topic exchange -- notifications-service consumes them (see its
// messaging/consumer.py). Best effort, like every other publisher: what the event announces
// already happened, so a broker that's down is logged, never surfaced as an error. The
// connection opens on first use and reopens after it drops.
import crypto from 'crypto';
import amqp from 'amqplib';
import { getTransactionByPaymentId } from './db.js';
import { getBooking } from './bookingClient.js';

const EVENTS_EXCHANGE = 'parklink.events';

let channelPromise = null;

function getChannel(url) {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(url);
      const reset = () => {
        channelPromise = null;
      };
      connection.on('close', reset);
      connection.on('error', reset);
      const channel = await connection.createChannel();
      await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
      return channel;
    })();
    channelPromise.catch(() => {
      channelPromise = null;
    });
  }
  return channelPromise;
}

export async function publishEvent(routingKey, payload) {
  const url = process.env.RABBITMQ_URL;
  if (!url) {
    console.warn(`[Events] RABBITMQ_URL not set, not publishing ${routingKey}`);
    return;
  }
  const event = {
    event_id: crypto.randomUUID(),
    event_type: routingKey,
    occurred_at: new Date().toISOString(),
    ...payload,
  };
  try {
    const channel = await getChannel(url);
    channel.publish(EVENTS_EXCHANGE, routingKey, Buffer.from(JSON.stringify(event)), {
      contentType: 'application/json',
      persistent: true,
      messageId: event.event_id,
    });
  } catch (error) {
    channelPromise = null;
    console.error(`[Events] failed to publish ${routingKey}:`, error.message);
  }
}

/**
 * Tells the driver a refund that had failed finally reached them -- Mercado Pago accepted
 * a retry (`method: "mercadopago"`), or an admin returned the money some other way
 * (`method: "manual"`). A refund that went through on the first try needs no extra notice:
 * the cancellation's own notification already says the money is on its way back.
 */
export async function announceRefundCompleted(paymentId, method) {
  try {
    const transaction = await getTransactionByPaymentId(paymentId);
    if (!transaction?.external_reference) return;
    const booking = await getBooking(transaction.external_reference);
    if (!booking?.user_id) return;
    await publishEvent('refund.completed', {
      booking_id: booking.id,
      parking_spot_id: booking.parking_spot_id ?? null,
      driver_user_id: booking.user_id,
      amount: Math.round(Number(transaction.amount) * 100),
      method,
    });
  } catch (error) {
    console.error(`[Events] could not announce the refund of payment ${paymentId}:`, error.message);
  }
}

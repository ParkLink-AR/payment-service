// Service-to-service calls into booking-service. Never gateway-routed: authenticated with
// the INTERNAL_SERVICE_KEY both services share.
import { config } from './config.js';

function internalHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Internal-Key': config.internalServiceKey,
  };
}

// The booking as booking-service sees it -- { id, user_id, status, amount (centavos),
// debt_amount (centavos, the driver's pending balances it took on: the payment covers both),
// hold_expires_at } -- or null if it doesn't exist. Throws on any other failure.
export async function getBooking(bookingId) {
  const response = await fetch(
    `${config.bookingServiceUrl}/internal/bookings/${encodeURIComponent(bookingId)}`,
    { headers: internalHeaders() },
  );
  if (response.status === 404 || response.status === 400) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`booking-service responded ${response.status}`);
  }
  return response.json();
}

// The pending balances bookingId's payment includes -- [{ amount (centavos), minutes,
// booking_start, parking_spot_title, ... }] -- for wording the checkout. Throws on failure.
export async function getBookingDebts(bookingId) {
  const response = await fetch(
    `${config.bookingServiceUrl}/internal/bookings/${encodeURIComponent(bookingId)}/debts`,
    { headers: internalHeaders() },
  );
  if (!response.ok) {
    throw new Error(`booking-service responded ${response.status}`);
  }
  return (await response.json()).debts ?? [];
}

// Asks booking-service to confirm bookingId as paid by paymentId, which charged
// amountCentavos. Resolves to { ok, status, code } -- code is booking-service's error code
// (e.g. HOLD_EXPIRED) when it refused.
export async function confirmBooking(bookingId, paymentId, amountCentavos) {
  const response = await fetch(`${config.bookingServiceUrl}/bookings/${encodeURIComponent(bookingId)}/confirm`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({ payment_id: String(paymentId), amount: amountCentavos }),
  });
  if (response.ok) {
    return { ok: true, status: response.status, code: null };
  }
  let code = null;
  try {
    code = (await response.json())?.code ?? null;
  } catch {
    // Non-JSON error body -- the status alone is enough to log.
  }
  return { ok: false, status: response.status, code };
}

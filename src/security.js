import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'crypto';

export function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ detail: 'Missing token' });
  }

  try {
    const payload = jwt.verify(
      authHeader.slice(7),
      process.env.JWT_SECRET
    );

    if (payload.role !== 'admin') {
      return res.status(403).json({
        detail: 'Admin privileges required'
      });
    }

    req.user = payload;
    next();
  } catch {
    return res.status(401).json({
      detail: 'Invalid token'
    });
  }
}

// Guards service-to-service calls (booking-service -> payment-service) that
// aren't gateway-routed and don't carry a user's JWT -- a shared secret
// instead, same "this port is directly reachable" reasoning as requireAdmin.
export function requireInternalKey(req, res, next) {
  const provided = Buffer.from(String(req.headers['x-internal-key'] || ''));
  const expected = Buffer.from(String(process.env.INTERNAL_SERVICE_KEY || ''));

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return res.status(401).json({ detail: 'Invalid internal key' });
  }
  next();
}

// Optional validation to ensure requests coming through gateway carry valid gateway secret
export function requireGatewaySecret(req, res, next) {
  const gatewaySecret = process.env.GATEWAY_INTERNAL_SECRET;
  if (!gatewaySecret) {
    return next(); // If not configured, pass through (e.g. dev mode)
  }
  const provided = Buffer.from(String(req.headers['x-gateway-secret'] || ''));
  const expected = Buffer.from(String(gatewaySecret));

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return res.status(403).json({ detail: 'Forbidden: request must originate from Gateway' });
  }
  next();
}
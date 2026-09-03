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
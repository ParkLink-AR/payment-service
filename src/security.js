import jwt from 'jsonwebtoken';

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
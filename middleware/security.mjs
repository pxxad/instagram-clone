// Security headers, Content-Security-Policy, and CSRF/Origin verification middleware.

export const CSP = [
  "default-src 'self'",
  "img-src 'self' https: data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

/**
 * Sets strict protective headers on all HTTP responses:
 * - Content-Security-Policy
 * - X-Content-Type-Options: nosniff
 * - Referrer-Policy: strict-origin-when-cross-origin
 * - Cross-Origin-Opener-Policy: same-origin
 * - Permissions-Policy: camera=(), microphone=(), geolocation=()
 */
export function securityHeaders(req, res, next) {
  res.set({
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  next();
}

/**
 * Validates request Origin and Referer for state-changing HTTP methods (POST, PUT, PATCH, DELETE).
 * Requests from foreign origins are blocked with 403 Forbidden.
 * Requests without Origin/Referer (e.g. direct same-site form posts / standard browser submits) are allowed.
 */
export function csrfOriginCheck(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const from = req.get("origin") || req.get("referer");
  if (from) {
    let host = "";
    try {
      host = new URL(from).host;
    } catch {}
    if (host !== req.get("host")) {
      return res.status(403).send("This request came from another website and was blocked.");
    }
  }
  next();
}

// Authentication and session middleware for user context, route protection, and session lifecycle.
import * as auth from "../lib/auth.mjs";
import { cookie, wantsJson, back, route } from "../lib/http-helpers.mjs";

/**
 * Creates the auth context middleware.
 * Reads the session cookie, verifies its cryptographic signature using secret,
 * retrieves the user record from the store, and populates req.me and res.locals.
 */
export function createAuthContextMiddleware({ store, secret }) {
  return route(async (req, res) => {
    const cookies = auth.parseCookies(req.get("cookie"));
    const userId = auth.readSession(cookies[auth.SESSION_COOKIE], secret);
    req.me = userId ? await store.userById(userId) : null;
    res.locals.me = req.me;
    res.locals.theme = ["light", "dark"].includes(cookies.theme) ? cookies.theme : "system";
    res.locals.flash = cookies.flash || "";
    if (cookies.flash) res.clearCookie("flash");
    res.locals.active = "";
    res.locals.title = "";
    res.locals.path = req.originalUrl;
    res.locals.unread = req.me && req.method === "GET" && !req.query.fragment ? await store.unreadThreads(req.me.id) : 0;
  }, true);
}

/**
 * Route protection middleware for authenticated endpoints.
 * Allows authenticated requests (req.me exists) through.
 * Responds with HTTP 401 JSON for API/fetch clients.
 * Redirects to /login?next=<encodedUrl> for browser navigation.
 */
export function needLogin(req, res, next) {
  if (req.me) return next();
  if (wantsJson(req)) return res.status(401).json({ error: "Log in to continue.", login: "/login" });
  const nextUrl = req.method === "GET" ? req.originalUrl : back(req, "/");
  res.redirect(303, `/login?next=${encodeURIComponent(nextUrl)}`);
}

/**
 * Creates and sets an authenticated session cookie on the response.
 */
export function loginUser(req, res, userId, secret) {
  res.cookie(
    auth.SESSION_COOKIE,
    auth.sessionToken(userId, secret),
    cookie(req, auth.SESSION_DAYS * 86_400_000)
  );
}

/**
 * Clears the session cookie, logging out the user.
 */
export function logoutUser(res) {
  res.clearCookie(auth.SESSION_COOKIE, { path: "/" });
}

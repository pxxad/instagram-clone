// Shared HTTP helpers for routing, parsing, response handling, and rendering.
import * as music from "./music.mjs";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Async route handlers: errors go to the error handler instead of crashing the server. `middleware` calls next() after. */
export function route(fn, middleware = false) {
  return (req, res, next) => Promise.resolve(fn(req, res)).then(() => middleware && next(), next);
}

export const cookie = (req, maxAge) => ({
  httpOnly: true,
  sameSite: "lax",
  secure: req.secure,
  path: "/",
  maxAge,
});

export const flash = (req, res, message) => res.cookie("flash", message, cookie(req, 60_000));

export const wantsJson = (req) => (req.get("accept") || "").includes("application/json");

export const str = (v) => (typeof v === "string" ? v.trim() : "");

export const pageNumber = (req) => Math.min(1000, Math.max(1, Number.parseInt(req.query.page, 10) || 1));

export const localPath = (p) => (typeof p === "string" && /^\/(?![/\\])/.test(p) ? p : "");

/** The page the request came from, if it is on this site. */
export function back(req, fallback) {
  try {
    const url = new URL(req.get("referer"));
    if (url.host === req.get("host")) return url.pathname + url.search;
  } catch {}
  return fallback;
}

/** Answers a like/save/follow: JSON for the page's script, or a redirect for a plain form. */
export const done = (req, res, data, fallback) =>
  wantsJson(req) ? res.json(data) : res.redirect(303, back(req, fallback));

export const notFound = (res) => res.status(404).render("404", { title: "Page not found" });

export const renderToString = (app, view, locals) =>
  new Promise((ok, fail) => app.render(view, locals, (err, html) => (err ? fail(err) : ok(html))));

export const trackId = (v) => (music.trackOf(v) ? v : "");

export const sortTray = (tray, myId) =>
  tray.sort((a, b) => (b.user.id === myId) - (a.user.id === myId) || (b.unseen > 0) - (a.unseen > 0) || b.latest - a.latest);

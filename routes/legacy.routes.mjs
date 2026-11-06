// Legacy redirects: old v1 URL scheme redirected permanently (301) to their modern equivalents.
import { Router } from "express";

/**
 * Creates the legacy redirect router.
 * All redirects are HTTP 301 (Moved Permanently).
 *
 * Mappings:
 *   GET /posts            → /
 *   GET /posts/new        → /create
 *   GET /posts/:id        → /p/:id        (id URL-encoded)
 *   GET /posts/:id/edit   → /p/:id/edit   (id URL-encoded)
 *   GET /reel/:id         → /reels?start=:id  (id URL-encoded)
 */
export function createLegacyRouter() {
  const router = Router();

  router.get("/posts", (req, res) => res.redirect(301, "/"));
  router.get("/posts/new", (req, res) => res.redirect(301, "/create"));
  router.get("/posts/:id", (req, res) => res.redirect(301, `/p/${encodeURIComponent(req.params.id)}`));
  router.get("/posts/:id/edit", (req, res) => res.redirect(301, `/p/${encodeURIComponent(req.params.id)}/edit`));
  router.get("/reel/:id", (req, res) => res.redirect(301, `/reels?start=${encodeURIComponent(req.params.id)}`));

  return router;
}


// Reels routes: browsing vertical video reels and tracking post/reel views.
import { Router } from "express";
import { UUID, route, pageNumber } from "../lib/http-helpers.mjs";

export const REELS_PAGE = 5; // reels per page

/**
 * Creates the reels router.
 * Handles:
 * - GET /reels: Browsing reels with pagination, optional ?start=<id> reel spotlight, and following status.
 * - POST /p/:id/view: Records view count on a reel or post.
 */
export function createReelsRouter({ store, pageSize = REELS_PAGE }) {
  const router = Router();

  router.get("/reels", route(async (req, res) => {
    const page = pageNumber(req);
    const viewer = req.me?.id ?? "";
    let reels = await store.reels(viewer, { limit: pageSize + 1, offset: (page - 1) * pageSize });
    const nextUrl = reels.length > pageSize && `/reels?page=${page + 1}`;
    reels = reels.slice(0, pageSize);
    // /reels?start=<id> opens a particular reel first (from a profile or a shared link).
    const start = page === 1 && UUID.test(req.query.start ?? "") ? await store.getPost(req.query.start, viewer) : null;
    if (start?.kind === "reel") reels = [start, ...reels.filter((r) => r.id !== start.id)];
    if (req.me) await Promise.all(reels.map(async (r) => (r.following = await store.isFollowing(req.me.id, r.user.id))));
    if (req.query.fragment) return res.render("partials/reel-items", { reels, nextUrl });
    res.render("reels", { title: "Reels", active: "reels", reels, nextUrl, bodyClass: "reels-page" });
  }));

  router.post("/p/:id/view", route(async (req, res) => {
    if (UUID.test(req.params.id)) await store.addView(req.params.id);
    res.status(204).end();
  }));

  return router;
}

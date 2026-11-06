// Home feed route: following feed (cursor pagination) and for-you feed (offset pagination).
import { Router } from "express";
import { parseCursor } from "../store/shared.mjs";
import { route, pageNumber, sortTray } from "../lib/http-helpers.mjs";

export const PAGE_SIZE = 8; // feed posts per page

/**
 * Creates the home feed router.
 * Handles:
 * - GET /: Authenticated home feed with "following" (cursor) and "foryou" (page) tabs,
 *   story tray, suggestions, and partial fragment rendering for infinite scroll.
 */
export function createFeedRouter({ store, pageSize = PAGE_SIZE }) {
  const router = Router();

  router.get("/", route(async (req, res) => {
    if (!req.me) return res.redirect("/login");
    const tab = req.query.tab === "foryou" ? "foryou" : "following";
    let posts, nextUrl;

    if (tab === "following") {
      const page = await store.feed(req.me.id, { limit: pageSize, before: parseCursor(req.query.cursor) });
      posts = page.posts;
      nextUrl = page.next && `/?cursor=${page.next}`;
    } else {
      const page = pageNumber(req);
      posts = await store.explore(req.me.id, { limit: pageSize + 1, offset: (page - 1) * pageSize });
      nextUrl = posts.length > pageSize && `/?tab=foryou&page=${page + 1}`;
      posts = posts.slice(0, pageSize);
    }

    const first = !req.query.cursor && !req.query.page;
    if (req.query.fragment) return res.render("partials/feed-items", { posts, nextUrl, tab, first });

    const [tray, suggestions] = await Promise.all([
      store.storyTray(req.me.id),
      store.suggestions(req.me.id, 5),
    ]);

    res.render("home", {
      active: "home",
      posts,
      nextUrl,
      tab,
      first,
      tray: sortTray(tray, req.me.id),
      suggestions,
    });
  }));

  return router;
}


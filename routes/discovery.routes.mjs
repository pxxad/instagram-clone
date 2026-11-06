// Discovery routes: explore grid, hashtags, audio track pages, search, and user notifications.
import { Router } from "express";
import * as music from "../lib/music.mjs";
import { TAG } from "../store/shared.mjs";
import {
  route,
  str,
  notFound,
  grid,
  offset,
  GRID_SIZE,
} from "../lib/http-helpers.mjs";

/**
 * Creates the discovery and activity router.
 * Handles:
 * - GET /explore: Explore feed of trending posts
 * - GET /explore/tags/:tag: Posts tagged with a specific hashtag
 * - GET /audio/:id: Posts using a specific audio track
 * - GET /search: Real-time search for users and hashtags
 * - GET /activity: Notifications feed grouped by time intervals
 */
export function createDiscoveryRouter({ store, needLogin, gridSize = GRID_SIZE }) {
  const router = Router();

  router.get("/explore", route(async (req, res) => {
    const posts = await store.explore(req.me?.id ?? "", { limit: gridSize + 1, offset: offset(req, gridSize) });
    await grid("explore", gridSize)(req, res, posts, { title: "Explore", active: "explore", layout: "explore" });
  }));

  router.get("/explore/tags/:tag", route(async (req, res) => {
    const tag = req.params.tag.toLowerCase();
    if (!TAG.test(tag)) return notFound(res);
    const [posts, total] = await Promise.all([
      store.tagPosts(tag, req.me?.id ?? "", { limit: gridSize + 1, offset: offset(req, gridSize) }),
      store.tagCount(tag),
    ]);
    if (!total) return notFound(res);
    await grid("tag", gridSize)(req, res, posts, { title: `#${tag}`, active: "explore", tag, total, layout: "explore" });
  }));

  router.get("/audio/:id", route(async (req, res) => {
    const track = music.trackOf(req.params.id);
    if (!track) return notFound(res);
    const [posts, total] = await Promise.all([
      store.audioPosts(track.id, req.me?.id ?? "", { limit: gridSize + 1, offset: offset(req, gridSize) }),
      store.audioCount(track.id),
    ]);
    await grid("audio", gridSize)(req, res, posts, {
      title: `${track.title} • ${track.artist}`,
      active: "explore",
      track,
      total,
      layout: "profile",
    });
  }));

  router.get("/search", route(async (req, res) => {
    const q = str(req.query.q).slice(0, 60);
    const word = q.replace(/^[#@]/, "");
    const users = word ? await store.searchUsers(word, 20) : [];
    const tag = q.startsWith("#") || !users.length ? word.toLowerCase() : "";
    const tagTotal = tag && TAG.test(tag) ? await store.tagCount(tag) : 0;
    const data = { q, users, tag: tagTotal ? tag : "", tagTotal };
    if (req.query.fragment) return res.render("partials/search-results", data);
    res.render("search", { ...data, title: "Search", active: "search" });
  }));

  router.get("/activity", needLogin, route(async (req, res) => {
    const items = await store.activity(req.me.id, { limit: 100 });
    const now = Date.now();

    // Likes on the same photo in the same period become one line: "a, b and 3 others liked your photo."
    const combineLikes = (list) => {
      const byPost = new Map();
      return list.filter((it) => {
        if (it.type !== "like") return true;
        const first = byPost.get(it.post.id);
        if (!first) {
          byPost.set(it.post.id, Object.assign(it, { also: [] }));
          return true;
        }
        first.also.push(it.user);
        return false;
      });
    };

    const groups = [
      ["Today", 86_400_000],
      ["This week", 7 * 86_400_000],
      ["This month", 30 * 86_400_000],
      ["Earlier", Infinity],
    ]
      .map(([label, within], i, all) => ({
        label,
        items: combineLikes(
          items.filter((it) => now - it.created_at < within && (i === 0 || now - it.created_at >= all[i - 1][1]))
        ),
      }))
      .filter((g) => g.items.length);

    res.render("activity", { title: "Notifications", active: "activity", groups });
  }));

  return router;
}


// Stories routes: viewing active stories and marking stories as seen.
import { Router } from "express";
import * as text from "../lib/text.mjs";
import { UUID, route, notFound, sortTray } from "../lib/http-helpers.mjs";

/**
 * Creates the stories router.
 * Handles:
 * - GET /stories/:username: View active 24-hour stories for a user with tray sequence navigation.
 * - POST /stories/:id/seen: Mark a story as seen by the authenticated user.
 */
export function createStoriesRouter({
  store,
  needLogin,
  findUser = async (username) =>
    text.USERNAME.test(username) && !text.RESERVED.has(username) ? store.userByUsername(username) : null,
}) {
  const router = Router();

  router.get("/stories/:username", route(async (req, res) => {
    const user = await findUser(req.params.username);
    if (!user) return notFound(res);
    const stories = await store.stories(user.id, req.me?.id ?? "");
    if (!stories.length) return res.redirect(`/${user.username}`);

    // Next and previous accounts in the viewer's story tray, so the player moves on like Instagram's.
    const tray = req.me ? sortTray(await store.storyTray(req.me.id), req.me.id).map((t) => t.user.username) : [];
    const i = tray.indexOf(user.username);
    const start = Math.max(0, stories.findIndex((s) => !s.seen));
    res.render("stories", {
      title: `Stories • ${user.username}`,
      user,
      stories,
      start,
      prev: i > 0 ? tray[i - 1] : "",
      next: i >= 0 && i < tray.length - 1 ? tray[i + 1] : "",
    });
  }));

  router.post("/stories/:id/seen", needLogin, route(async (req, res) => {
    if (UUID.test(req.params.id)) await store.markSeen(req.me.id, req.params.id);
    res.status(204).end();
  }));

  return router;
}

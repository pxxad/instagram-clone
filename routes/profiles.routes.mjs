// User profiles and social graph: view profile tabs (posts, reels, reposts, saved),
// follow/unfollow actions, and followers/following lists.
import { Router } from "express";
import * as text from "../lib/text.mjs";
import {
  route,
  wantsJson,
  notFound,
  done,
  offset,
  grid,
  GRID_SIZE,
} from "../lib/http-helpers.mjs";

const TABS = ["posts", "reels", "reposts", "saved"];

/**
 * Creates the profiles and social relationships router.
 *
 * Routes:
 * - POST /:username/follow: Follow a user (rejects self-follow)
 * - DELETE /:username/follow: Unfollow a user
 * - GET /:username: View user's profile and posts tab
 * - GET /:username/reels: View user's reels tab
 * - GET /:username/reposts: View user's reposts tab
 * - GET /:username/saved: View user's saved posts (private to profile owner)
 * - GET /:username/followers: List of user's followers
 * - GET /:username/following: List of accounts the user follows
 */
export function createProfilesRouter({ store, needLogin, findUser, gridSize = GRID_SIZE }) {
  const router = Router();
  const lookupUser = findUser || (async (u) => (text.USERNAME.test(u) && !text.RESERVED.has(u) ? store.userByUsername(u) : null));

  const followRoute = (follow) => [
    needLogin,
    route(async (req, res) => {
      const user = await lookupUser(req.params.username);
      if (!user) {
        return wantsJson(req)
          ? res.status(404).json({ error: "This account doesn't exist." })
          : notFound(res);
      }
      if (user.id === req.me.id) {
        return wantsJson(req)
          ? res.status(400).json({ error: "You can't follow yourself." })
          : res.redirect(303, `/${user.username}`);
      }
      await (follow ? store.follow(req.me.id, user.id) : store.unfollow(req.me.id, user.id));
      const counts = await store.profileCounts(user.id);
      done(req, res, { following: follow, followers: counts.followers }, `/${user.username}`);
    }),
  ];

  router.post("/:username/follow", ...followRoute(true));
  router.delete("/:username/follow", ...followRoute(false));

  async function profile(req, res, tab) {
    const user = await lookupUser(req.params.username);
    if (!user) return notFound(res);
    const own = req.me?.id === user.id;
    if (tab === "saved" && !own) return res.redirect(`/${user.username}`);

    const viewer = req.me?.id ?? "";
    const opts = { limit: gridSize + 1, offset: offset(req, gridSize) };
    const list = {
      posts: () => store.userPosts(user.id, viewer, opts),
      reels: () => store.userPosts(user.id, viewer, { ...opts, kind: "reel" }),
      reposts: () => store.repostsBy(user.id, viewer, opts),
      saved: () => store.savedPosts(user.id, opts),
    }[tab]();

    const layout = tab === "reels" ? "reels" : "profile";
    if (req.query.fragment) return grid("profile", gridSize)(req, res, await list, { layout });

    const [posts, counts, following, followsYou, mutuals, stories] = await Promise.all([
      list,
      store.profileCounts(user.id),
      req.me && !own ? store.isFollowing(req.me.id, user.id) : false,
      req.me && !own ? store.isFollowing(user.id, req.me.id) : false,
      req.me && !own ? store.mutuals(req.me.id, user.id) : { names: [], total: 0 },
      store.stories(user.id, viewer),
    ]);

    await grid("profile", gridSize)(req, res, posts, {
      title: user.name ? `${user.name} (@${user.username})` : `@${user.username}`,
      active: own ? "profile" : "",
      layout,
      user,
      own,
      tab,
      counts,
      following,
      followsYou,
      mutuals,
      story: stories.length ? (stories.every((s) => s.seen) ? "seen" : "new") : "",
    });
  }

  for (const tab of TABS) {
    router.get(
      tab === "posts" ? "/:username" : `/:username/${tab}`,
      route((req, res) => profile(req, res, tab))
    );
  }

  const people = (which) =>
    route(async (req, res) => {
      const user = await lookupUser(req.params.username);
      if (!user) return notFound(res);
      const list = await store[which](user.id, req.me?.id ?? "");
      res.render("people", {
        title: `${which === "followers" ? "Followers" : "Following"} • @${user.username}`,
        user,
        which,
        list,
      });
    });

  router.get("/:username/followers", people("followers"));
  router.get("/:username/following", people("following"));

  return router;
}

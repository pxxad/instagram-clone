// The web app: an Instagram-style network with accounts, a feed, stories, reels, likes, comments,
// saves, reposts, follows, direct messages, music, profiles, explore, hashtags, search and notifications.
// Every page is rendered on the server and works without JavaScript; public/app.js adds the
// instant likes, double-tap, infinite scroll, pop-ups, players, live messages and keyboard shortcuts.
// Data storage and image storage are passed in, so the app runs the same against MySQL or in memory.
import express from "express";
import methodOverride from "method-override";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as auth from "./lib/auth.mjs";
import * as text from "./lib/text.mjs";
import * as music from "./lib/music.mjs";
import { icon } from "./lib/icons.mjs";
import { parseCursor, TAG } from "./store/shared.mjs";
import {
  UUID,
  route,
  flash,
  wantsJson,
  str,
  pageNumber,
  localPath,
  back,
  done,
  notFound,
  renderToString as renderViewToString,
  trackId,
  sortTray,
} from "./lib/http-helpers.mjs";
import { securityHeaders, csrfOriginCheck } from "./middleware/security.mjs";
import { createAuthContextMiddleware, needLogin } from "./middleware/auth.mjs";
import { createUploadMiddleware } from "./middleware/upload.mjs";
import { createAuthRouter } from "./routes/auth.routes.mjs";
import { createSettingsRouter } from "./routes/settings.routes.mjs";
import { createReelsRouter } from "./routes/reels.routes.mjs";
import { createStoriesRouter } from "./routes/stories.routes.mjs";
import { createCommentsRouter } from "./routes/comments.routes.mjs";
import { createPostsRouter } from "./routes/posts.routes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PAGE_SIZE = 8; // feed posts per page
export const GRID_SIZE = 24; // tiles per page on profiles, explore and hashtags
export const REELS_PAGE = 5; // reels per page

/**
 * store:      the data (store/mysql.mjs or store/memory.mjs)
 * storeImage: (uploadedFile) => URL of the stored image or video (images.mjs)
 * secret:     signs the session cookies (SESSION_SECRET)
 * demo:       { username, password } to show a "Log in as demo" button, or null
 * uploadDir:  where multer keeps uploads (default public/uploads)
 */
export function createApp({ store, storeImage, secret, demo = null, uploadDir = path.join(here, "public", "uploads") }) {
  if (!secret) throw new Error("createApp needs a secret for the session cookies");
  const app = express();
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(here, "views"));
  Object.assign(app.locals, {
    icon, rich: text.rich, ago: text.ago, agoLong: text.agoLong, fullDate: text.fullDate, clock: text.clock,
    count: text.count, compact: text.compact, plural: text.plural, length: text.length,
    avatarOf: text.avatarOf, altOf: text.altOf, FILTERS: text.FILTERS, ASPECTS: text.ASPECTS, LIMITS: text.LIMITS,
    TRACKS: music.TRACKS, trackOf: music.trackOf, trackUrl: music.trackUrl,
    demo,
  });
  // Live events for open pages (new messages, read receipts), keyed by user id.
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  app.use(securityHeaders);
  app.use(express.static(path.join(here, "public"), { maxAge: "1h" }));
  const catalogCss = text.filtersCss() + music.coversCss();
  app.get("/catalog.css", (req, res) => res.type("css").set("Cache-Control", "public, max-age=3600").send(catalogCss));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));
  app.use(express.json({ limit: "100kb" }));
  app.use(methodOverride("_method"));
  app.use(csrfOriginCheck);

  // Who is logged in (from the signed cookie), the theme, unread messages, and one-time messages.
  app.use(createAuthContextMiddleware({ store, secret }));

  // ---- Helpers -------------------------------------------------------------
  const renderToString = (view, locals) => renderViewToString(app, view, locals);

  const findPost = async (req) => (UUID.test(req.params.id) ? store.getPost(req.params.id, req.me?.id ?? "") : null);
  const findUser = async (username) => (text.USERNAME.test(username) && !text.RESERVED.has(username) ? store.userByUsername(username) : null);
  const sortTray = (tray, myId) =>
    tray.sort((a, b) => (b.user.id === myId) - (a.user.id === myId) || (b.unseen > 0) - (a.unseen > 0) || b.latest - a.latest);

  // Uploads: only real photos and videos (checked by their first bytes, not just the browser's word),
  // saved under a random name with an extension chosen by us, so an upload can never be served as a web page.
  const { media } = createUploadMiddleware(uploadDir);

  // ---- Authentication & Appearance -------------------------------------------
  app.use(createAuthRouter({ store, secret }));

  // ---- Home feed -----------------------------------------------------------------
  app.get("/", route(async (req, res) => {
    if (!req.me) return res.redirect("/login");
    const tab = req.query.tab === "foryou" ? "foryou" : "following";
    let posts, nextUrl;
    if (tab === "following") {
      const page = await store.feed(req.me.id, { limit: PAGE_SIZE, before: parseCursor(req.query.cursor) });
      posts = page.posts;
      nextUrl = page.next && `/?cursor=${page.next}`;
    } else {
      const page = pageNumber(req);
      posts = await store.explore(req.me.id, { limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
      nextUrl = posts.length > PAGE_SIZE && `/?tab=foryou&page=${page + 1}`;
      posts = posts.slice(0, PAGE_SIZE);
    }
    const first = !req.query.cursor && !req.query.page;
    if (req.query.fragment) return res.render("partials/feed-items", { posts, nextUrl, tab, first });
    const [tray, suggestions] = await Promise.all([store.storyTray(req.me.id), store.suggestions(req.me.id, 5)]);
    res.render("home", { active: "home", posts, nextUrl, tab, first, tray: sortTray(tray, req.me.id), suggestions });
  }));

  // ---- Explore, hashtags, music, search, notifications -----------------------------------------
  const grid = (view) => async (req, res, posts, locals) => {
    const page = pageNumber(req);
    const more = posts.length > GRID_SIZE;
    const url = new URL(req.originalUrl, "http://x");
    url.searchParams.delete("fragment");
    url.searchParams.set("page", page + 1);
    const data = { ...locals, posts: posts.slice(0, GRID_SIZE), nextUrl: more && url.pathname + url.search };
    res.render(req.query.fragment ? "partials/grid-items" : view, data);
  };
  const offset = (req) => (pageNumber(req) - 1) * GRID_SIZE;

  app.get("/explore", route(async (req, res) => {
    const posts = await store.explore(req.me?.id ?? "", { limit: GRID_SIZE + 1, offset: offset(req) });
    await grid("explore")(req, res, posts, { title: "Explore", active: "explore", layout: "explore" });
  }));

  app.get("/explore/tags/:tag", route(async (req, res) => {
    const tag = req.params.tag.toLowerCase();
    if (!TAG.test(tag)) return notFound(res);
    const [posts, total] = await Promise.all([
      store.tagPosts(tag, req.me?.id ?? "", { limit: GRID_SIZE + 1, offset: offset(req) }),
      store.tagCount(tag),
    ]);
    if (!total) return notFound(res);
    await grid("tag")(req, res, posts, { title: `#${tag}`, active: "explore", tag, total, layout: "explore" });
  }));

  app.get("/audio/:id", route(async (req, res) => {
    const track = music.trackOf(req.params.id);
    if (!track) return notFound(res);
    const [posts, total] = await Promise.all([
      store.audioPosts(track.id, req.me?.id ?? "", { limit: GRID_SIZE + 1, offset: offset(req) }),
      store.audioCount(track.id),
    ]);
    await grid("audio")(req, res, posts, { title: `${track.title} • ${track.artist}`, active: "explore", track, total, layout: "profile" });
  }));

  app.get("/search", route(async (req, res) => {
    const q = str(req.query.q).slice(0, 60);
    const word = q.replace(/^[#@]/, "");
    const users = word ? await store.searchUsers(word, 20) : [];
    const tag = q.startsWith("#") || !users.length ? word.toLowerCase() : "";
    const tagTotal = tag && TAG.test(tag) ? await store.tagCount(tag) : 0;
    const data = { q, users, tag: tagTotal ? tag : "", tagTotal };
    if (req.query.fragment) return res.render("partials/search-results", data);
    res.render("search", { ...data, title: "Search", active: "search" });
  }));

  app.get("/activity", needLogin, route(async (req, res) => {
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
    const groups = [["Today", 86_400_000], ["This week", 7 * 86_400_000], ["This month", 30 * 86_400_000], ["Earlier", Infinity]]
      .map(([label, within], i, all) => ({
        label,
        items: combineLikes(items.filter((it) => now - it.created_at < within && (i === 0 || now - it.created_at >= all[i - 1][1]))),
      }))
      .filter((g) => g.items.length);
    res.render("activity", { title: "Notifications", active: "activity", groups });
  }));

  // ---- Reels ------------------------------------------------------------------------------------
  app.use(createReelsRouter({ store, pageSize: REELS_PAGE }));

  // ---- Posts -----------------------------------------------------------------------------
  app.use(createPostsRouter({ store, storeImage, media, needLogin, uploadDir, findPost }));

  // ---- Comments ---------------------------------------------------------------------------
  app.use(createCommentsRouter({ store, needLogin, renderToString, findPost }));

  // ---- Stories -------------------------------------------------------------------------------
  app.use(createStoriesRouter({ store, needLogin, findUser }));

  // ---- Direct messages ------------------------------------------------------------------------------
  const inboxPage = async (req, res, extra = {}) => {
    const chats = await store.inbox(req.me.id);
    res.render("direct", { title: "Messages", active: "direct", bodyClass: "direct-page", chats, other: null, messages: [], ...extra });
  };
  app.get("/direct/inbox", needLogin, route(inboxPage));
  app.get("/direct", needLogin, (req, res) => res.redirect("/direct/inbox"));

  app.get("/direct/new", needLogin, route(async (req, res) => {
    const q = str(req.query.q).slice(0, 60).replace(/^@/, "");
    const users = (q ? await store.searchUsers(q, 20) : await store.shareTargets(req.me.id, 20)).filter((u) => u.id !== req.me.id);
    res.render("direct-new", { title: "New message", active: "direct", q, users });
  }));

  app.get("/direct/t/:username", needLogin, route(async (req, res) => {
    const other = await findUser(req.params.username);
    if (!other || other.id === req.me.id) return notFound(res);
    if (await store.markRead(req.me.id, other.id)) {
      bus.emit(other.id, { type: "read", by: req.me.username });
      res.locals.unread = await store.unreadThreads(req.me.id);
    }
    const messages = await store.thread(req.me.id, other.id);
    await inboxPage(req, res, { other, messages, title: `${other.name || other.username} • Messages` });
  }));

  /** Sends a message (text, or a shared post) and tells the recipient's open pages. */
  async function send(req, res, other, { body, post }) {
    const message = { id: randomUUID(), senderId: req.me.id, recipientId: other.id, body, postId: post?.id ?? null, createdAt: new Date() };
    await store.sendMessage(message);
    const view = {
      id: message.id, body, created_at: message.createdAt, read_at: null,
      post: post ? { id: post.id, kind: post.kind, image: post.image, filter: post.filter, caption: post.caption, user: { username: post.user.username, avatar: post.user.avatar } } : null,
    };
    bus.emit(other.id, { type: "message", from: req.me, message: view });
    return view;
  }

  app.post("/direct/t/:username", needLogin, route(async (req, res) => {
    const other = await findUser(req.params.username);
    if (!other || other.id === req.me.id) return wantsJson(req) ? res.status(404).json({ error: "This account doesn't exist." }) : notFound(res);
    const body = str(req.body.body);
    if (!body || text.length(body) > text.LIMITS.comment) {
      const error = body ? `Messages can be up to ${text.count(text.LIMITS.comment)} characters.` : "Write a message first.";
      return wantsJson(req) ? res.status(400).json({ error }) : res.status(400).send(error);
    }
    const view = await send(req, res, other, { body });
    if (!wantsJson(req)) return res.redirect(303, `/direct/t/${other.username}`);
    res.json({ html: await renderToString("partials/message", { ...res.locals, m: { ...view, mine: true }, other }) });
  }));

  // Share a post into chats: the share sheet lists recent chats and the people you follow.
  app.get("/p/:id/share", needLogin, route(async (req, res) => {
    const post = await findPost(req);
    if (!post) return notFound(res);
    const people = await store.shareTargets(req.me.id, 50);
    res.render(req.query.fragment ? "partials/share-sheet" : "share", { title: "Share", post, people });
  }));

  app.post("/p/:id/share", needLogin, route(async (req, res) => {
    const post = await findPost(req);
    const other = post && (await findUser(str(req.body.to)));
    if (!post || !other || other.id === req.me.id) return wantsJson(req) ? res.status(404).json({ error: "Couldn't send that. Try again." }) : notFound(res);
    await send(req, res, other, { body: str(req.body.body).slice(0, 500), post });
    done(req, res, { sent: true, to: other.username }, `/direct/t/${other.username}`);
  }));

  // New messages and read receipts arrive on open pages as Server-Sent Events.
  app.get("/direct/events", needLogin, (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write("retry: 4000\n\n");
    const me = req.me;
    const listener = async (event) => {
      try {
        if (event.type === "message") {
          const html = await renderToString("partials/message", { me, m: { ...event.message, mine: false }, other: event.from });
          const unread = await store.unreadThreads(me.id);
          res.write(`event: message\ndata: ${JSON.stringify({ from: event.from.username, name: event.from.name, html, unread })}\n\n`);
        } else if (event.type === "read") {
          res.write(`event: read\ndata: ${JSON.stringify({ by: event.by })}\n\n`);
        }
      } catch (err) {
        console.error(err);
      }
    };
    bus.on(me.id, listener);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      bus.off(me.id, listener);
      clearInterval(ping);
    });
  });

  app.post("/direct/t/:username/read", needLogin, route(async (req, res) => {
    const other = await findUser(req.params.username);
    if (other && (await store.markRead(req.me.id, other.id))) bus.emit(other.id, { type: "read", by: req.me.username });
    res.json({ unread: await store.unreadThreads(req.me.id) });
  }));

  // ---- Settings ----------------------------------------------------------------------------------
  app.use(createSettingsRouter({ store, storeImage, media, needLogin }));

  // ---- Old addresses from the first version of the app ---------------------------------------
  app.get("/posts", (req, res) => res.redirect(301, "/"));
  app.get("/posts/new", (req, res) => res.redirect(301, "/create"));
  app.get("/posts/:id", (req, res) => res.redirect(301, `/p/${encodeURIComponent(req.params.id)}`));
  app.get("/posts/:id/edit", (req, res) => res.redirect(301, `/p/${encodeURIComponent(req.params.id)}/edit`));
  app.get("/reel/:id", (req, res) => res.redirect(301, `/reels?start=${encodeURIComponent(req.params.id)}`));

  // ---- Profiles (last, because /:username matches any single word) ------------------------------
  const followRoute = (follow) => [needLogin, route(async (req, res) => {
    const user = await findUser(req.params.username);
    if (!user) return wantsJson(req) ? res.status(404).json({ error: "This account doesn't exist." }) : notFound(res);
    if (user.id === req.me.id) return wantsJson(req) ? res.status(400).json({ error: "You can't follow yourself." }) : res.redirect(303, `/${user.username}`);
    await (follow ? store.follow(req.me.id, user.id) : store.unfollow(req.me.id, user.id));
    const counts = await store.profileCounts(user.id);
    done(req, res, { following: follow, followers: counts.followers }, `/${user.username}`);
  })];
  app.post("/:username/follow", ...followRoute(true));
  app.delete("/:username/follow", ...followRoute(false));

  const TABS = ["posts", "reels", "reposts", "saved"];
  async function profile(req, res, tab) {
    const user = await findUser(req.params.username);
    if (!user) return notFound(res);
    const own = req.me?.id === user.id;
    if (tab === "saved" && !own) return res.redirect(`/${user.username}`);
    const viewer = req.me?.id ?? "";
    const opts = { limit: GRID_SIZE + 1, offset: offset(req) };
    const list = {
      posts: () => store.userPosts(user.id, viewer, opts),
      reels: () => store.userPosts(user.id, viewer, { ...opts, kind: "reel" }),
      reposts: () => store.repostsBy(user.id, viewer, opts),
      saved: () => store.savedPosts(user.id, opts),
    }[tab]();
    const layout = tab === "reels" ? "reels" : "profile";
    if (req.query.fragment) return grid("profile")(req, res, await list, { layout });
    const [posts, counts, following, followsYou, mutuals, stories] = await Promise.all([
      list,
      store.profileCounts(user.id),
      req.me && !own ? store.isFollowing(req.me.id, user.id) : false,
      req.me && !own ? store.isFollowing(user.id, req.me.id) : false,
      req.me && !own ? store.mutuals(req.me.id, user.id) : { names: [], total: 0 },
      store.stories(user.id, viewer),
    ]);
    await grid("profile")(req, res, posts, {
      title: user.name ? `${user.name} (@${user.username})` : `@${user.username}`,
      active: own ? "profile" : "", layout,
      user, own, tab, counts, following, followsYou, mutuals,
      story: stories.length ? (stories.every((s) => s.seen) ? "seen" : "new") : "",
    });
  }
  for (const tab of TABS) app.get(tab === "posts" ? "/:username" : `/:username/${tab}`, route((req, res) => profile(req, res, tab)));

  const people = (which) => route(async (req, res) => {
    const user = await findUser(req.params.username);
    if (!user) return notFound(res);
    const list = await store[which](user.id, req.me?.id ?? "");
    res.render("people", { title: `${which === "followers" ? "Followers" : "Following"} • @${user.username}`, user, which, list });
  });
  app.get("/:username/followers", people("followers"));
  app.get("/:username/following", people("following"));

  // ---- Errors ------------------------------------------------------------------------------------
  app.use((req, res) => notFound(res));
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    if (wantsJson(req)) return res.status(500).json({ error: "Something went wrong. Try again." });
    // The error may have happened before the page settings were set up.
    const defaults = { me: null, theme: "system", flash: "", active: "", path: "/", unread: 0 };
    for (const [k, v] of Object.entries(defaults)) if (!(k in res.locals)) res.locals[k] = v;
    res.status(500).render("error", { title: "Error" });
  });
  return app;
}

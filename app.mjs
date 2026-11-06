// The web app: modular server-rendered Instagram clone with accounts, feed, stories, reels,
// likes, comments, saves, reposts, follows, DMs, music, profiles, explore, search and notifications.
import express from "express";
import methodOverride from "method-override";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as text from "./lib/text.mjs";
import * as music from "./lib/music.mjs";
import { icon } from "./lib/icons.mjs";
import { UUID, wantsJson, notFound, renderToString as renderViewToString } from "./lib/http-helpers.mjs";
import { securityHeaders, csrfOriginCheck } from "./middleware/security.mjs";
import { createAuthContextMiddleware, needLogin } from "./middleware/auth.mjs";
import { createUploadMiddleware } from "./middleware/upload.mjs";
import { createAuthRouter } from "./routes/auth.routes.mjs";
import { createFeedRouter } from "./routes/feed.routes.mjs";
import { createDiscoveryRouter } from "./routes/discovery.routes.mjs";
import { createSettingsRouter } from "./routes/settings.routes.mjs";
import { createReelsRouter } from "./routes/reels.routes.mjs";
import { createStoriesRouter } from "./routes/stories.routes.mjs";
import { createCommentsRouter } from "./routes/comments.routes.mjs";
import { createPostsRouter } from "./routes/posts.routes.mjs";
import { createMessagesRouter } from "./routes/messages.routes.mjs";
import { createLegacyRouter } from "./routes/legacy.routes.mjs";
import { createProfilesRouter } from "./routes/profiles.routes.mjs";
import { createRealtimeBus } from "./lib/realtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export { PAGE_SIZE } from "./routes/feed.routes.mjs"; // feed posts per page
export const GRID_SIZE = 24; // tiles per page on profiles, explore and hashtags
export const REELS_PAGE = 5; // reels per page

/** createApp wires security, auth context, uploads, event bus, and modular route handlers. */
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
  const bus = createRealtimeBus();

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

  // Uploads: only real photos and videos, saved under a random UUID name.
  const { media } = createUploadMiddleware(uploadDir);

  // ---- Route modules --------------------------------------------------------
  app.use(createAuthRouter({ store, secret }));
  app.use(createFeedRouter({ store }));
  app.use(createDiscoveryRouter({ store, needLogin, gridSize: GRID_SIZE }));
  app.use(createReelsRouter({ store, pageSize: REELS_PAGE }));
  app.use(createPostsRouter({ store, storeImage, media, needLogin, uploadDir, findPost }));
  app.use(createCommentsRouter({ store, needLogin, renderToString, findPost }));
  app.use(createStoriesRouter({ store, needLogin, findUser }));
  app.use(createMessagesRouter({ store, needLogin, bus, renderToString, findUser, findPost }));
  app.use(createSettingsRouter({ store, storeImage, media, needLogin }));
  app.use(createLegacyRouter());
  app.use(createProfilesRouter({ store, needLogin, findUser, gridSize: GRID_SIZE })); // Registered last before 404

  // ---- Errors ---------------------------------------------------------------
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

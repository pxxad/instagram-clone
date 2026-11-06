// Direct messaging, post sharing, and real-time Server-Sent Events (SSE).
import { Router } from "express";
import { randomUUID } from "node:crypto";
import * as text from "../lib/text.mjs";
import {
  UUID,
  route,
  str,
  done,
  notFound,
  wantsJson,
  renderToString as renderViewToString,
} from "../lib/http-helpers.mjs";

/**
 * Creates the direct messages and post-sharing router.
 * Handles:
 * - GET /direct/inbox: List active chats
 * - GET /direct: Redirects to /direct/inbox
 * - GET /direct/new: Recipient search
 * - GET /direct/t/:username: Open conversation thread and mark read
 * - POST /direct/t/:username: Send message
 * - POST /direct/t/:username/read: Mark conversation read
 * - GET /p/:id/share: Post sharing sheet
 * - POST /p/:id/share: Share post to chat
 * - GET /direct/events: Server-Sent Events (SSE) live notifications stream
 */
export function createMessagesRouter({
  store,
  needLogin,
  bus,
  renderToString = (view, locals, req) => renderViewToString(req.app, view, locals),
  findUser = async (username) =>
    text.USERNAME.test(username) && !text.RESERVED.has(username) ? store.userByUsername(username) : null,
  findPost = async (req) => (UUID.test(req.params.id) ? store.getPost(req.params.id, req.me?.id ?? "") : null),
}) {
  const router = Router();

  // Unified event dispatcher supporting either custom RealtimeBus or standard EventEmitter
  const emitEvent = (recipientId, event) => {
    if (!recipientId || !bus) return;
    bus.emit(recipientId, event);
  };

  const subscribeEvents = (userId, listener) => {
    if (!userId || !bus) return () => {};
    if (typeof bus.subscribe === "function") {
      return bus.subscribe(userId, listener);
    }
    bus.on(userId, listener);
    return () => bus.off(userId, listener);
  };

  const inboxPage = async (req, res, extra = {}) => {
    const chats = await store.inbox(req.me.id);
    res.render("direct", {
      title: "Messages",
      active: "direct",
      bodyClass: "direct-page",
      chats,
      other: null,
      messages: [],
      ...extra,
    });
  };

  /** Sends a message (text, or a shared post) and notifies the recipient's open pages. */
  async function send(req, res, other, { body, post }) {
    const message = {
      id: randomUUID(),
      senderId: req.me.id,
      recipientId: other.id,
      body,
      postId: post?.id ?? null,
      createdAt: new Date(),
    };
    await store.sendMessage(message);
    const view = {
      id: message.id,
      body,
      created_at: message.createdAt,
      read_at: null,
      post: post
        ? {
            id: post.id,
            kind: post.kind,
            image: post.image,
            filter: post.filter,
            caption: post.caption,
            user: { username: post.user.username, avatar: post.user.avatar },
          }
        : null,
    };
    emitEvent(other.id, { type: "message", from: req.me, message: view });
    return view;
  }

  // ---- Inbox & Threads --------------------------------------------------------------------
  router.get("/direct/inbox", needLogin, route(inboxPage));
  router.get("/direct", needLogin, (req, res) => res.redirect("/direct/inbox"));

  router.get("/direct/new", needLogin, route(async (req, res) => {
    const q = str(req.query.q).slice(0, 60).replace(/^@/, "");
    const users = (q ? await store.searchUsers(q, 20) : await store.shareTargets(req.me.id, 20)).filter(
      (u) => u.id !== req.me.id
    );
    res.render("direct-new", { title: "New message", active: "direct", q, users });
  }));

  router.get("/direct/t/:username", needLogin, route(async (req, res) => {
    const other = await findUser(req.params.username);
    if (!other || other.id === req.me.id) return notFound(res);
    if (await store.markRead(req.me.id, other.id)) {
      emitEvent(other.id, { type: "read", by: req.me.username });
      res.locals.unread = await store.unreadThreads(req.me.id);
    }
    const messages = await store.thread(req.me.id, other.id);
    await inboxPage(req, res, { other, messages, title: `${other.name || other.username} • Messages` });
  }));

  router.post("/direct/t/:username", needLogin, route(async (req, res) => {
    const other = await findUser(req.params.username);
    if (!other || other.id === req.me.id) {
      return wantsJson(req) ? res.status(404).json({ error: "This account doesn't exist." }) : notFound(res);
    }
    const body = str(req.body.body);
    if (!body || text.length(body) > text.LIMITS.comment) {
      const error = body ? `Messages can be up to ${text.count(text.LIMITS.comment)} characters.` : "Write a message first.";
      return wantsJson(req) ? res.status(400).json({ error }) : res.status(400).send(error);
    }
    const view = await send(req, res, other, { body });
    if (!wantsJson(req)) return res.redirect(303, `/direct/t/${other.username}`);
    const html = await renderToString("partials/message", { ...res.locals, m: { ...view, mine: true }, other }, req);
    res.json({ html });
  }));

  router.post("/direct/t/:username/read", needLogin, route(async (req, res) => {
    const other = await findUser(req.params.username);
    if (other && (await store.markRead(req.me.id, other.id))) {
      emitEvent(other.id, { type: "read", by: req.me.username });
    }
    res.json({ unread: await store.unreadThreads(req.me.id) });
  }));

  // ---- Share Sheet ------------------------------------------------------------------------
  router.get("/p/:id/share", needLogin, route(async (req, res) => {
    const post = await findPost(req);
    if (!post) return notFound(res);
    const people = await store.shareTargets(req.me.id, 50);
    res.render(req.query.fragment ? "partials/share-sheet" : "share", { title: "Share", post, people });
  }));

  router.post("/p/:id/share", needLogin, route(async (req, res) => {
    const post = await findPost(req);
    const other = post && (await findUser(str(req.body.to)));
    if (!post || !other || other.id === req.me.id) {
      return wantsJson(req) ? res.status(404).json({ error: "Couldn't send that. Try again." }) : notFound(res);
    }
    await send(req, res, other, { body: str(req.body.body).slice(0, 500), post });
    done(req, res, { sent: true, to: other.username }, `/direct/t/${other.username}`);
  }));

  // ---- Server-Sent Events -----------------------------------------------------------------
  router.get("/direct/events", needLogin, (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("retry: 4000\n\n");

    const me = req.me;
    let isCleanedUp = false;

    const listener = async (event) => {
      if (isCleanedUp || res.writableEnded) return;
      try {
        if (event.type === "message") {
          const html = await renderToString(
            "partials/message",
            { me, m: { ...event.message, mine: false }, other: event.from },
            req
          );
          const unread = await store.unreadThreads(me.id);
          if (!isCleanedUp && !res.writableEnded) {
            res.write(`event: message\ndata: ${JSON.stringify({ from: event.from.username, name: event.from.name, html, unread })}\n\n`);
          }
        } else if (event.type === "read") {
          if (!isCleanedUp && !res.writableEnded) {
            res.write(`event: read\ndata: ${JSON.stringify({ by: event.by })}\n\n`);
          }
        }
      } catch (err) {
        console.error(err);
      }
    };

    const unsubscribe = subscribeEvents(me.id, listener);
    const ping = setInterval(() => {
      if (!isCleanedUp && !res.writableEnded) {
        res.write(": ping\n\n");
      }
    }, 25_000);

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      clearInterval(ping);
      unsubscribe();
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("finish", cleanup);
    req.on("error", cleanup);
  });

  return router;
}

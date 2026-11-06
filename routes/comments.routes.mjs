// Comments routes: adding and deleting comments on posts.
import { Router } from "express";
import { randomUUID } from "node:crypto";
import * as text from "../lib/text.mjs";
import {
  UUID,
  route,
  wantsJson,
  str,
  back,
  done,
  notFound,
  renderToString as renderViewToString,
} from "../lib/http-helpers.mjs";

/**
 * Creates the comments router.
 * Handles:
 * - POST /p/:id/comments: Add comment to post with character limits and JSON/HTML response.
 * - DELETE /comments/:id: Delete comment (allowed by comment author OR post owner).
 */
export function createCommentsRouter({
  store,
  needLogin,
  renderToString = (view, locals, req) => renderViewToString(req.app, view, locals),
  findPost = async (req) => (UUID.test(req.params.id) ? store.getPost(req.params.id, req.me?.id ?? "") : null),
}) {
  const router = Router();

  router.post("/p/:id/comments", needLogin, route(async (req, res) => {
    const post = await findPost(req);
    if (!post) return wantsJson(req) ? res.status(404).json({ error: "This post was deleted." }) : notFound(res);
    const body = str(req.body.body);
    if (!body || text.length(body) > text.LIMITS.comment) {
      const error = body ? `Comments can be up to ${text.count(text.LIMITS.comment)} characters.` : "Write a comment first.";
      return wantsJson(req) ? res.status(400).json({ error }) : res.status(400).send(error);
    }
    const id = randomUUID();
    await store.addComment({ id, postId: post.id, userId: req.me.id, body });
    if (!wantsJson(req)) return res.redirect(303, back(req, `/p/${post.id}`));
    const comment = { id, post_id: post.id, body, created_at: new Date(), user: req.me };
    const html = await renderToString("partials/comment", { ...res.locals, comment, post }, req);
    res.json({ html, comment_count: post.comment_count + 1 });
  }));

  router.delete("/comments/:id", needLogin, route(async (req, res) => {
    const comment = UUID.test(req.params.id) ? await store.getComment(req.params.id) : null;
    if (!comment) return wantsJson(req) ? res.status(404).json({ error: "This comment was deleted." }) : notFound(res);
    const post = await store.getPost(comment.post_id, req.me.id);
    // People can delete their own comments, and any comment on their own posts.
    if (comment.user_id !== req.me.id && post.user.id !== req.me.id) {
      return res.status(403).send("You can only delete your own comments.");
    }
    await store.removeComment(comment.id);
    done(req, res, { deleted: true, comment_count: post.comment_count - 1 }, `/p/${post.id}`);
  }));

  return router;
}

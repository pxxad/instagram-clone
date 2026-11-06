import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createCommentsRouter } from "../routes/comments.routes.mjs";
import { needLogin } from "../middleware/auth.mjs";

test("POST /p/:id/comments validates login and request body", async () => {
  const postId = "00000000-0000-0000-0000-000000000001";
  const mockPost = { id: postId, user: { id: "user-author" }, comment_count: 5 };

  const mockStore = {
    async getPost(id) {
      if (id === postId) return mockPost;
      return null;
    },
    async addComment() {},
  };

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((req, res, next) => {
    req.me = { id: "user-me", username: "me" };
    next();
  });
  app.use(createCommentsRouter({
    store: mockStore,
    needLogin,
    renderToString: async () => "<div>rendered comment</div>",
  }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  // 1. Empty body returns 400
  const resEmpty = await fetch(`http://127.0.0.1:${port}/p/${postId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ body: "   " }),
  });
  assert.equal(resEmpty.status, 400);

  // 2. Successful comment with JSON
  const resValid = await fetch(`http://127.0.0.1:${port}/p/${postId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ body: "Great shot!" }),
  });
  assert.equal(resValid.status, 200);
  const jsonValid = await resValid.json();
  assert.equal(jsonValid.comment_count, 6);
  assert.equal(jsonValid.html, "<div>rendered comment</div>");

  await new Promise((ok) => server.close(ok));
});

test("DELETE /comments/:id authorization checks", async () => {
  const commentId = "11111111-1111-1111-1111-111111111111";
  const postId = "22222222-2222-2222-2222-222222222222";
  const mockComment = { id: commentId, post_id: postId, user_id: "comment-author" };
  const mockPost = { id: postId, user: { id: "post-owner" }, comment_count: 10 };

  let removedId = null;
  const mockStore = {
    async getComment(id) {
      if (id === commentId) return mockComment;
      return null;
    },
    async getPost(id) {
      if (id === postId) return mockPost;
      return null;
    },
    async removeComment(id) {
      removedId = id;
    },
  };

  const createTestApp = (user) => {
    const app = express();
    app.use((req, res, next) => {
      req.me = user;
      next();
    });
    app.use(createCommentsRouter({ store: mockStore, needLogin }));
    return app;
  };

  // Case 1: Unauthorized user (neither comment author nor post owner) receives 403
  const appStranger = createTestApp({ id: "stranger" });
  const serverStranger = await new Promise((ok) => {
    const s = appStranger.listen(0, () => ok(s));
  });
  const portStranger = serverStranger.address().port;

  const resForbidden = await fetch(`http://127.0.0.1:${portStranger}/comments/${commentId}`, {
    method: "DELETE",
    headers: { "Accept": "application/json" },
  });
  assert.equal(resForbidden.status, 403);
  await new Promise((ok) => serverStranger.close(ok));

  // Case 2: Comment author can delete
  const appAuthor = createTestApp({ id: "comment-author" });
  const serverAuthor = await new Promise((ok) => {
    const s = appAuthor.listen(0, () => ok(s));
  });
  const portAuthor = serverAuthor.address().port;

  removedId = null;
  const resAuthor = await fetch(`http://127.0.0.1:${portAuthor}/comments/${commentId}`, {
    method: "DELETE",
    headers: { "Accept": "application/json" },
  });
  assert.equal(resAuthor.status, 200);
  assert.equal(removedId, commentId);
  await new Promise((ok) => serverAuthor.close(ok));

  // Case 3: Post owner can delete any comment on their post
  const appOwner = createTestApp({ id: "post-owner" });
  const serverOwner = await new Promise((ok) => {
    const s = appOwner.listen(0, () => ok(s));
  });
  const portOwner = serverOwner.address().port;

  removedId = null;
  const resOwner = await fetch(`http://127.0.0.1:${portOwner}/comments/${commentId}`, {
    method: "DELETE",
    headers: { "Accept": "application/json" },
  });
  assert.equal(resOwner.status, 200);
  assert.equal(removedId, commentId);
  await new Promise((ok) => serverOwner.close(ok));
});

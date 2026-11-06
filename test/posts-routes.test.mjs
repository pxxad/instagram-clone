import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createPostsRouter } from "../routes/posts.routes.mjs";
import { needLogin } from "../middleware/auth.mjs";

test("GET /create authorization and default values", async () => {
  const app = express();
  let renderData = null;
  app.set("view engine", "ejs");
  app.engine("ejs", (p, d, cb) => {
    renderData = d;
    cb(null, "create-form");
  });

  app.use((req, res, next) => {
    req.me = { id: "user-1", username: "alice" };
    next();
  });

  app.use(createPostsRouter({
    store: {},
    storeImage: async () => "",
    media: (req, res, next) => next(),
    needLogin,
    uploadDir: "",
  }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/create`);
  assert.equal(res.status, 200);
  assert.equal(renderData.title, "Create");
  assert.equal(renderData.values.kind, "post");
  assert.equal(renderData.values.filter, "normal");

  await new Promise((ok) => server.close(ok));
});

test("GET /p/:id renders post detail or 404", async () => {
  const postId = "00000000-0000-0000-0000-000000000001";
  const mockPost = {
    id: postId,
    caption: "A sunny day in the park",
    user: { id: "user-alice", username: "alice", name: "Alice" },
  };

  const mockStore = {
    async getPost(id) {
      if (id === postId) return mockPost;
      return null;
    },
    async comments() {
      return [];
    },
    async userPosts() {
      return [];
    },
    async isFollowing() {
      return false;
    },
  };

  let renderData = null;
  const app = express();
  app.set("view engine", "ejs");
  app.engine("ejs", (p, d, cb) => {
    renderData = d;
    cb(null, "post-detail");
  });

  app.use(createPostsRouter({
    store: mockStore,
    storeImage: async () => "",
    media: (req, res, next) => next(),
    needLogin,
    uploadDir: "",
  }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  // Existing post
  const res = await fetch(`http://127.0.0.1:${port}/p/${postId}`);
  assert.equal(res.status, 200);
  assert.equal(renderData.post.id, postId);

  // Missing post returns 404
  const res404 = await fetch(`http://127.0.0.1:${port}/p/nonexistent-uuid`);
  assert.equal(res404.status, 404);

  await new Promise((ok) => server.close(ok));
});

test("GET /p/:id/edit and DELETE /p/:id authorization (author only)", async () => {
  const postId = "11111111-1111-1111-1111-111111111111";
  const mockPost = {
    id: postId,
    caption: "My photo",
    image: "/uploads/photo.jpg",
    user: { id: "owner-id", username: "owner" },
  };

  let postDeleted = false;
  const mockStore = {
    async getPost(id) {
      if (id === postId) return mockPost;
      return null;
    },
    async removePost(id) {
      if (id === postId) postDeleted = true;
    },
  };

  const createTestApp = (user) => {
    const app = express();
    app.set("view engine", "ejs");
    app.engine("ejs", (p, d, cb) => cb(null, "edit-view"));
    app.use((req, res, next) => {
      req.me = user;
      next();
    });
    app.use(createPostsRouter({
      store: mockStore,
      storeImage: async () => "",
      media: (req, res, next) => next(),
      needLogin,
      uploadDir: "",
    }));
    return app;
  };

  // Stranger receives 403 Forbidden
  const appStranger = createTestApp({ id: "stranger-id", username: "stranger" });
  const serverStranger = await new Promise((ok) => {
    const s = appStranger.listen(0, () => ok(s));
  });
  const portStranger = serverStranger.address().port;

  const resForbidden = await fetch(`http://127.0.0.1:${portStranger}/p/${postId}/edit`);
  assert.equal(resForbidden.status, 403);
  await new Promise((ok) => serverStranger.close(ok));

  // Owner succeeds
  const appOwner = createTestApp({ id: "owner-id", username: "owner" });
  const serverOwner = await new Promise((ok) => {
    const s = appOwner.listen(0, () => ok(s));
  });
  const portOwner = serverOwner.address().port;

  const resOwner = await fetch(`http://127.0.0.1:${portOwner}/p/${postId}/edit`);
  assert.equal(resOwner.status, 200);

  // Owner delete
  const resDelete = await fetch(`http://127.0.0.1:${portOwner}/p/${postId}`, {
    method: "DELETE",
    headers: { "Accept": "application/json" },
  });
  assert.equal(resDelete.status, 200);
  assert.equal(postDeleted, true);

  await new Promise((ok) => serverOwner.close(ok));
});

test("POST /p/:id/repost prevents self-reposts", async () => {
  const postId = "22222222-2222-2222-2222-222222222222";
  const mockPost = {
    id: postId,
    user: { id: "user-123", username: "alice" },
  };

  const mockStore = {
    async getPost(id) {
      if (id === postId) return mockPost;
      return null;
    },
  };

  const app = express();
  app.use((req, res, next) => {
    req.me = { id: "user-123", username: "alice" };
    next();
  });
  app.use(createPostsRouter({
    store: mockStore,
    storeImage: async () => "",
    media: (req, res, next) => next(),
    needLogin,
    uploadDir: "",
  }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/p/${postId}/repost`, {
    method: "POST",
    headers: { "Accept": "application/json" },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "You can't repost your own post.");

  await new Promise((ok) => server.close(ok));
});

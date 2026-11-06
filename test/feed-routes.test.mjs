import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createFeedRouter } from "../routes/feed.routes.mjs";

test("GET / unauthenticated redirects to /login", async () => {
  const app = express();
  app.use(createFeedRouter({ store: {} }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login");

  await new Promise((ok) => server.close(ok));
});

test("GET / following tab with cursor pagination, story tray and suggestions", async () => {
  const dummyPosts = [
    { id: "p1", caption: "First post", user: { username: "bob" } },
    { id: "p2", caption: "Second post", user: { username: "alice" } },
  ];
  const dummyTray = [
    { user: { id: "user-bob", username: "bob" }, unseen: 1, latest: 200 },
  ];
  const dummySuggestions = [
    { id: "user-charlie", username: "charlie" },
  ];

  let feedQueriedWith = null;
  const mockStore = {
    async feed(userId, opts) {
      feedQueriedWith = { userId, opts };
      return { posts: dummyPosts, next: "cursor-12345" };
    },
    async storyTray() {
      return dummyTray;
    },
    async suggestions() {
      return dummySuggestions;
    },
  };

  let renderData = null;
  const app = express();
  app.set("view engine", "ejs");
  app.engine("ejs", (p, d, cb) => {
    renderData = d;
    cb(null, "home-view");
  });

  app.use((req, res, next) => {
    req.me = { id: "viewer-1", username: "viewer" };
    next();
  });
  app.use(createFeedRouter({ store: mockStore, pageSize: 8 }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.equal(renderData.active, "home");
  assert.equal(renderData.tab, "following");
  assert.equal(renderData.nextUrl, "/?cursor=cursor-12345");
  assert.equal(renderData.posts.length, 2);
  assert.equal(renderData.suggestions.length, 1);
  assert.equal(feedQueriedWith.userId, "viewer-1");

  await new Promise((ok) => server.close(ok));
});

test("GET /?tab=foryou page pagination and ?fragment=1 partial rendering", async () => {
  const dummyExplorePosts = Array.from({ length: 9 }, (_, i) => ({
    id: `exp-${i + 1}`,
    caption: `Explore post ${i + 1}`,
  }));

  const mockStore = {
    async explore(userId, { limit, offset }) {
      return dummyExplorePosts.slice(offset, offset + limit);
    },
    async storyTray() {
      return [];
    },
    async suggestions() {
      return [];
    },
  };

  let renderedTemplate = null;
  let renderData = null;
  const app = express();
  app.set("view engine", "ejs");
  app.engine("ejs", (p, d, cb) => {
    renderedTemplate = p;
    renderData = d;
    cb(null, "items-fragment");
  });

  app.use((req, res, next) => {
    req.me = { id: "viewer-1", username: "viewer" };
    next();
  });
  app.use(createFeedRouter({ store: mockStore, pageSize: 8 }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  // Fragment request for foryou tab
  const resFrag = await fetch(`http://127.0.0.1:${port}/?tab=foryou&page=1&fragment=1`);
  assert.equal(resFrag.status, 200);
  assert.ok(renderedTemplate.replace(/\\/g, "/").includes("partials/feed-items"));
  assert.equal(renderData.tab, "foryou");
  assert.equal(renderData.posts.length, 8);
  assert.equal(renderData.nextUrl, "/?tab=foryou&page=2");

  await new Promise((ok) => server.close(ok));
});

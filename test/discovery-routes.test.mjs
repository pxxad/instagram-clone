import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createDiscoveryRouter } from "../routes/discovery.routes.mjs";
import { needLogin } from "../middleware/auth.mjs";
import { TRACKS } from "../lib/music.mjs";

test("GET /explore renders explore grid with pagination", async () => {
  const dummyPosts = Array.from({ length: 25 }, (_, i) => ({ id: `post-${i + 1}` }));
  const mockStore = {
    async explore(viewer, { limit, offset }) {
      return dummyPosts.slice(offset, offset + limit);
    },
  };

  let renderData = null;
  const app = express();
  app.set("view engine", "ejs");
  app.engine("ejs", (p, d, cb) => {
    renderData = d;
    cb(null, "grid-view");
  });

  app.use(createDiscoveryRouter({ store: mockStore, needLogin, gridSize: 24 }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/explore`);
  assert.equal(res.status, 200);
  assert.equal(renderData.title, "Explore");
  assert.equal(renderData.posts.length, 24);
  assert.equal(renderData.nextUrl, "/explore?page=2");

  await new Promise((ok) => server.close(ok));
});

test("GET /explore/tags/:tag validates tag regex and 404s", async () => {
  const mockStore = {
    async tagPosts(tag, viewer, { limit, offset }) {
      return [{ id: "tag-p1" }];
    },
    async tagCount(tag) {
      if (tag === "sunset") return 10;
      return 0;
    },
  };

  let renderData = null;
  const app = express();
  app.set("view engine", "ejs");
  app.engine("ejs", (p, d, cb) => {
    renderData = d;
    cb(null, "tag-view");
  });

  app.use(createDiscoveryRouter({ store: mockStore, needLogin }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  // 1. Valid existing tag
  const resValid = await fetch(`http://127.0.0.1:${port}/explore/tags/sunset`);
  assert.equal(resValid.status, 200);
  assert.equal(renderData.title, "#sunset");
  assert.equal(renderData.total, 10);

  // 2. Non-existent tag (total = 0) returns 404
  const resMissing = await fetch(`http://127.0.0.1:${port}/explore/tags/nonexistenttag`);
  assert.equal(resMissing.status, 404);

  // 3. Invalid tag characters return 404
  const resInvalid = await fetch(`http://127.0.0.1:${port}/explore/tags/invalid%20tag!`);
  assert.equal(resInvalid.status, 404);

  await new Promise((ok) => server.close(ok));
});

test("GET /audio/:id validates track and renders audio page", async () => {
  const validTrack = TRACKS[0];
  const mockStore = {
    async audioPosts(trackId) {
      return [{ id: "audio-p1" }];
    },
    async audioCount(trackId) {
      return 5;
    },
  };

  let renderData = null;
  const app = express();
  app.set("view engine", "ejs");
  app.engine("ejs", (p, d, cb) => {
    renderData = d;
    cb(null, "audio-view");
  });

  app.use(createDiscoveryRouter({ store: mockStore, needLogin }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  // Valid track
  const resValid = await fetch(`http://127.0.0.1:${port}/audio/${validTrack.id}`);
  assert.equal(resValid.status, 200);
  assert.equal(renderData.title, `${validTrack.title} • ${validTrack.artist}`);
  assert.equal(renderData.total, 5);

  // Unknown track returns 404
  const resUnknown = await fetch(`http://127.0.0.1:${port}/audio/unknown-track-id-999`);
  assert.equal(resUnknown.status, 404);

  await new Promise((ok) => server.close(ok));
});

test("GET /search and GET /activity behavior", async () => {
  const mockStore = {
    async searchUsers(query) {
      return [{ id: "u1", username: query }];
    },
    async tagCount(tag) {
      return 15;
    },
    async activity(userId) {
      const now = Date.now();
      return [
        { type: "like", post: { id: "p1" }, user: { username: "bob" }, created_at: now - 1000 },
        { type: "like", post: { id: "p1" }, user: { username: "alice" }, created_at: now - 2000 },
        { type: "comment", post: { id: "p2" }, user: { username: "charlie" }, created_at: now - 3600000 },
      ];
    },
  };

  let renderData = null;
  const app = express();
  app.set("view engine", "ejs");
  app.engine("ejs", (p, d, cb) => {
    renderData = d;
    cb(null, "view");
  });

  app.use((req, res, next) => {
    req.me = { id: "viewer-1", username: "viewer" };
    next();
  });
  app.use(createDiscoveryRouter({ store: mockStore, needLogin }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  // Search
  const resSearch = await fetch(`http://127.0.0.1:${port}/search?q=alice`);
  assert.equal(resSearch.status, 200);
  assert.equal(renderData.title, "Search");
  assert.equal(renderData.users.length, 1);

  // Activity
  const resActivity = await fetch(`http://127.0.0.1:${port}/activity`);
  assert.equal(resActivity.status, 200);
  assert.equal(renderData.title, "Notifications");
  // The two likes on p1 should be combined into one group item
  const todayGroup = renderData.groups.find((g) => g.label === "Today");
  assert.ok(todayGroup);
  const combinedLike = todayGroup.items.find((it) => it.type === "like");
  assert.ok(combinedLike);
  assert.equal(combinedLike.also.length, 1); // alice was combined into also list

  await new Promise((ok) => server.close(ok));
});


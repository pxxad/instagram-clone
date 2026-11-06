import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createStoriesRouter } from "../routes/stories.routes.mjs";
import { needLogin } from "../middleware/auth.mjs";

test("GET /stories/:username returns 404 for non-existent user", async () => {
  const mockStore = {
    async userByUsername() {
      return null;
    },
  };

  const app = express();
  app.set("view engine", "ejs");
  app.engine("ejs", (p, d, cb) => cb(null, "404"));
  app.use(createStoriesRouter({ store: mockStore, needLogin }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/stories/nonexistent_user`);
  assert.equal(res.status, 404);

  await new Promise((ok) => server.close(ok));
});

test("GET /stories/:username redirects to profile when user has no stories", async () => {
  const mockStore = {
    async userByUsername(username) {
      return { id: "user-1", username };
    },
    async stories() {
      return [];
    },
  };

  const app = express();
  app.use(createStoriesRouter({ store: mockStore, needLogin }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/stories/alice`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/alice");

  await new Promise((ok) => server.close(ok));
});

test("GET /stories/:username renders active stories and tray navigation", async () => {
  const userAlice = { id: "user-alice", username: "alice" };
  const mockStories = [
    { id: "s1", image: "/uploads/s1.jpg", seen: true },
    { id: "s2", image: "/uploads/s2.jpg", seen: false },
  ];

  const mockStore = {
    async userByUsername(username) {
      if (username === "alice") return userAlice;
      return null;
    },
    async stories() {
      return mockStories;
    },
    async storyTray() {
      return [
        { user: { id: "user-bob", username: "bob" }, unseen: 1, latest: 100 },
        { user: { id: "user-alice", username: "alice" }, unseen: 1, latest: 200 },
        { user: { id: "user-charlie", username: "charlie" }, unseen: 0, latest: 50 },
      ];
    },
  };

  let renderedData = null;
  const app = express();
  app.set("view engine", "ejs");
  app.engine("ejs", (p, d, cb) => {
    renderedData = d;
    cb(null, "stories-page");
  });
  app.use((req, res, next) => {
    req.me = { id: "me-id", username: "me" };
    next();
  });
  app.use(createStoriesRouter({ store: mockStore, needLogin }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/stories/alice`);
  assert.equal(res.status, 200);
  assert.equal(renderedData.title, "Stories • alice");
  assert.equal(renderedData.start, 1); // s2 is first unseen story at index 1
  assert.equal(renderedData.stories.length, 2);

  await new Promise((ok) => server.close(ok));
});

test("POST /stories/:id/seen marks story as seen for logged-in user", async () => {
  let markedSeen = null;
  const mockStore = {
    async markSeen(userId, storyId) {
      markedSeen = { userId, storyId };
    },
  };

  const app = express();
  app.use((req, res, next) => {
    req.me = { id: "viewer-123" };
    next();
  });
  app.use(createStoriesRouter({ store: mockStore, needLogin }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const validUuid = "abcdef01-2345-6789-abcd-ef0123456789";
  const res = await fetch(`http://127.0.0.1:${port}/stories/${validUuid}/seen`, { method: "POST" });
  assert.equal(res.status, 204);
  assert.deepEqual(markedSeen, { userId: "viewer-123", storyId: validUuid });

  // Unauthenticated request redirected by needLogin
  const appUnauth = express();
  appUnauth.use(createStoriesRouter({ store: mockStore, needLogin }));
  const serverUnauth = await new Promise((ok) => {
    const s = appUnauth.listen(0, () => ok(s));
  });
  const portUnauth = serverUnauth.address().port;

  const resUnauth = await fetch(`http://127.0.0.1:${portUnauth}/stories/${validUuid}/seen`, {
    method: "POST",
    redirect: "manual",
  });
  assert.equal(resUnauth.status, 303);
  assert.ok(resUnauth.headers.get("location").includes("/login"));

  await new Promise((ok) => server.close(ok));
  await new Promise((ok) => serverUnauth.close(ok));
});

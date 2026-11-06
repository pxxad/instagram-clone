import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createReelsRouter } from "../routes/reels.routes.mjs";

test("GET /reels renders reels page with pagination", async () => {
  const dummyReels = Array.from({ length: 6 }, (_, i) => ({
    id: `00000000-0000-0000-0000-00000000000${i + 1}`,
    kind: "reel",
    user: { id: "user-1", username: "alice" },
  }));

  const mockStore = {
    async reels(viewer, { limit, offset }) {
      return dummyReels.slice(offset, offset + limit);
    },
    async isFollowing() {
      return false;
    },
  };

  const app = express();
  let renderedView = null;
  let renderData = null;
  app.set("view engine", "ejs");
  app.engine("ejs", (path, data, cb) => {
    renderedView = path;
    renderData = data;
    cb(null, "<html>reels</html>");
  });

  app.use(createReelsRouter({ store: mockStore, pageSize: 5 }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/reels`);
  assert.equal(res.status, 200);
  assert.equal(renderData.title, "Reels");
  assert.equal(renderData.reels.length, 5);
  assert.equal(renderData.nextUrl, "/reels?page=2");

  await new Promise((ok) => server.close(ok));
});

test("GET /reels?start=<id> prioritizes the start reel on first page", async () => {
  const startId = "11111111-1111-1111-1111-111111111111";
  const startReel = { id: startId, kind: "reel", user: { id: "user-9", username: "zara" } };

  const dummyReels = [
    { id: "00000000-0000-0000-0000-000000000001", kind: "reel", user: { id: "user-1" } },
    { id: "00000000-0000-0000-0000-000000000002", kind: "reel", user: { id: "user-2" } },
  ];

  const mockStore = {
    async reels() {
      return [...dummyReels];
    },
    async getPost(id) {
      if (id === startId) return startReel;
      return null;
    },
    async isFollowing() {
      return false;
    },
  };

  const app = express();
  let renderData = null;
  app.set("view engine", "ejs");
  app.engine("ejs", (path, data, cb) => {
    renderData = data;
    cb(null, "reels");
  });

  app.use(createReelsRouter({ store: mockStore, pageSize: 5 }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/reels?start=${startId}`);
  assert.equal(res.status, 200);
  assert.equal(renderData.reels[0].id, startId);

  await new Promise((ok) => server.close(ok));
});

test("GET /reels?fragment=1 renders partials/reel-items", async () => {
  const mockStore = {
    async reels() {
      return [{ id: "00000000-0000-0000-0000-000000000001", kind: "reel", user: { id: "user-1" } }];
    },
  };

  const app = express();
  let renderedTemplate = null;
  app.set("view engine", "ejs");
  app.engine("ejs", (path, data, cb) => {
    renderedTemplate = path;
    cb(null, "<div>reels fragment</div>");
  });

  app.use(createReelsRouter({ store: mockStore, pageSize: 5 }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/reels?fragment=1`);
  assert.equal(res.status, 200);
  assert.ok(renderedTemplate.endsWith("partials/reel-items") || renderedTemplate.includes("reel-items"));

  await new Promise((ok) => server.close(ok));
});

test("POST /p/:id/view records view and returns 204", async () => {
  let viewedPostId = null;
  const mockStore = {
    async addView(id) {
      viewedPostId = id;
    },
  };

  const app = express();
  app.use(createReelsRouter({ store: mockStore }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const validUuid = "12345678-1234-1234-1234-123456789abc";
  const res = await fetch(`http://127.0.0.1:${port}/p/${validUuid}/view`, { method: "POST" });
  assert.equal(res.status, 204);
  assert.equal(viewedPostId, validUuid);

  // Invalid UUID should be ignored safely and still return 204
  viewedPostId = null;
  const resInvalid = await fetch(`http://127.0.0.1:${port}/p/invalid-id/view`, { method: "POST" });
  assert.equal(resInvalid.status, 204);
  assert.equal(viewedPostId, null);

  await new Promise((ok) => server.close(ok));
});

// Unit tests for routes/profiles.routes.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createProfilesRouter } from "../routes/profiles.routes.mjs";

function setupApp({ store, currentUser = null, findUser = null }) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // Attach mock session user
  app.use((req, res, next) => {
    req.me = currentUser;
    next();
  });

  const needLogin = (req, res, next) => {
    if (!req.me) return res.redirect(303, "/login");
    next();
  };

  let lastRender = null;
  app.set("view engine", "ejs");
  app.engine("ejs", (path, data, cb) => {
    lastRender = { path, data };
    cb(null, "<html>rendered</html>");
  });

  app.use(createProfilesRouter({ store, needLogin, findUser, gridSize: 10 }));

  return { app, getLastRender: () => lastRender };
}

test("GET /:username renders user profile and post grid", async () => {
  const targetUser = { id: "user-1", username: "alice", name: "Alice Wonderland" };
  const mockStore = {
    async userByUsername(u) { return u === "alice" ? targetUser : null; },
    async userPosts() { return [{ id: "p1" }, { id: "p2" }]; },
    async profileCounts() { return { posts: 2, followers: 10, following: 5 }; },
    async isFollowing() { return false; },
    async mutuals() { return { names: [], total: 0 }; },
    async stories() { return []; },
  };

  const { app, getLastRender } = setupApp({ store: mockStore });
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/alice`);
    assert.equal(res.status, 200);
    const render = getLastRender();
    assert.ok(render.path.includes("profile"));
    assert.equal(render.data.title, "Alice Wonderland (@alice)");
    assert.equal(render.data.user.username, "alice");
    assert.equal(render.data.tab, "posts");
    assert.equal(render.data.posts.length, 2);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});

test("GET /:username returns 404 for unknown or reserved username", async () => {
  const mockStore = {
    async userByUsername() { return null; },
  };

  const { app, getLastRender } = setupApp({ store: mockStore });
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const port = server.address().port;

  try {
    // Non-existent user
    const res1 = await fetch(`http://127.0.0.1:${port}/ghost`);
    assert.equal(res1.status, 404);
    assert.ok(getLastRender().path.includes("404"));

    // Reserved username (e.g. explore) should not match as a user profile
    const res2 = await fetch(`http://127.0.0.1:${port}/explore`);
    assert.equal(res2.status, 404);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});

test("GET /:username/saved enforces strict privacy: only owner can view saved posts", async () => {
  const alice = { id: "user-1", username: "alice" };
  const bob = { id: "user-2", username: "bob" };

  const mockStore = {
    async userByUsername(u) { return u === "alice" ? alice : null; },
    async savedPosts() { return [{ id: "saved-1" }]; },
    async profileCounts() { return { posts: 0, followers: 0, following: 0 }; },
    async isFollowing() { return false; },
    async mutuals() { return { names: [], total: 0 }; },
    async stories() { return []; },
  };

  // 1. Bob (stranger) tries to access Alice's saved tab -> redirect to Alice's profile
  const { app: bobApp } = setupApp({ store: mockStore, currentUser: bob });
  const serverBob = await new Promise((ok) => { const s = bobApp.listen(0, () => ok(s)); });
  const portBob = serverBob.address().port;

  try {
    const resStranger = await fetch(`http://127.0.0.1:${portBob}/alice/saved`, { redirect: "manual" });
    assert.equal(resStranger.status, 302);
    assert.equal(resStranger.headers.get("location"), "/alice");

    // Fragment request by non-owner must also redirect
    const resStrangerFrag = await fetch(`http://127.0.0.1:${portBob}/alice/saved?fragment=1`, { redirect: "manual" });
    assert.equal(resStrangerFrag.status, 302);
    assert.equal(resStrangerFrag.headers.get("location"), "/alice");
  } finally {
    await new Promise((ok) => serverBob.close(ok));
  }

  // 2. Alice (owner) accesses her own saved tab -> 200 OK
  const { app: aliceApp, getLastRender } = setupApp({ store: mockStore, currentUser: alice });
  const serverAlice = await new Promise((ok) => { const s = aliceApp.listen(0, () => ok(s)); });
  const portAlice = serverAlice.address().port;

  try {
    const resOwner = await fetch(`http://127.0.0.1:${portAlice}/alice/saved`);
    assert.equal(resOwner.status, 200);
    assert.equal(getLastRender().data.tab, "saved");
    assert.equal(getLastRender().data.posts.length, 1);
  } finally {
    await new Promise((ok) => serverAlice.close(ok));
  }
});

test("POST and DELETE /:username/follow handles follow/unfollow and rejects self-follow", async () => {
  const alice = { id: "user-1", username: "alice" };
  const bob = { id: "user-2", username: "bob" };

  let followed = false;
  let unfollowed = false;

  const mockStore = {
    async userByUsername(u) {
      if (u === "alice") return alice;
      if (u === "bob") return bob;
      return null;
    },
    async follow(from, to) {
      if (from === bob.id && to === alice.id) followed = true;
    },
    async unfollow(from, to) {
      if (from === bob.id && to === alice.id) unfollowed = true;
    },
    async profileCounts() { return { followers: followed ? 11 : 10 }; },
  };

  const { app } = setupApp({ store: mockStore, currentUser: bob });
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const port = server.address().port;

  try {
    // 1. Bob follows Alice (JSON)
    const resFollow = await fetch(`http://127.0.0.1:${port}/alice/follow`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    assert.equal(resFollow.status, 200);
    const jsonFollow = await resFollow.json();
    assert.equal(jsonFollow.following, true);
    assert.equal(jsonFollow.followers, 11);
    assert.equal(followed, true);

    // 2. Bob unfollows Alice (DELETE)
    const resUnfollow = await fetch(`http://127.0.0.1:${port}/alice/follow`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    assert.equal(resUnfollow.status, 200);
    const jsonUnfollow = await resUnfollow.json();
    assert.equal(jsonUnfollow.following, false);
    assert.equal(unfollowed, true);

    // 3. Bob attempts to follow himself -> 400 Bad Request
    const resSelfFollow = await fetch(`http://127.0.0.1:${port}/bob/follow`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    assert.equal(resSelfFollow.status, 400);
    const jsonSelf = await resSelfFollow.json();
    assert.equal(jsonSelf.error, "You can't follow yourself.");

    // 4. Follow non-existent user -> 404
    const resGhost = await fetch(`http://127.0.0.1:${port}/ghost/follow`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    assert.equal(resGhost.status, 404);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});

test("GET /:username/followers and /:username/following render people lists", async () => {
  const alice = { id: "user-1", username: "alice" };
  const mockStore = {
    async userByUsername(u) { return u === "alice" ? alice : null; },
    async followers() { return [{ id: "f1", username: "fan1" }]; },
    async following() { return [{ id: "f2", username: "idol1" }]; },
  };

  const { app, getLastRender } = setupApp({ store: mockStore });
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const port = server.address().port;

  try {
    const resFollowers = await fetch(`http://127.0.0.1:${port}/alice/followers`);
    assert.equal(resFollowers.status, 200);
    assert.ok(getLastRender().path.includes("people"));
    assert.equal(getLastRender().data.which, "followers");
    assert.equal(getLastRender().data.list.length, 1);

    const resFollowing = await fetch(`http://127.0.0.1:${port}/alice/following`);
    assert.equal(resFollowing.status, 200);
    assert.ok(getLastRender().path.includes("people"));
    assert.equal(getLastRender().data.which, "following");
    assert.equal(getLastRender().data.list.length, 1);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});

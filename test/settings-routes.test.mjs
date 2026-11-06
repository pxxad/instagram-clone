import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createSettingsRouter } from "../routes/settings.routes.mjs";
import { needLogin } from "../middleware/auth.mjs";

test("GET /accounts/edit redirects unauthenticated user to login", async () => {
  const app = express();
  app.use(createSettingsRouter({
    store: {},
    storeImage: async () => "",
    media: (req, res, next) => next(),
    needLogin,
  }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/accounts/edit`, { redirect: "manual" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/login?next=%2Faccounts%2Fedit");

  await new Promise((ok) => server.close(ok));
});

test("POST /accounts/edit validates name length limit", async () => {
  const app = express();
  app.set("view engine", "ejs");
  app.engine("ejs", (path, data, cb) => cb(null, "render-stub"));

  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.me = { id: "user-1", username: "bob", name: "Bob", bio: "Hello" };
    next();
  });
  app.use(createSettingsRouter({
    store: {},
    storeImage: async () => "",
    media: (req, res, next) => next(),
    needLogin,
  }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  // Name exceeding 60 chars (LIMITS.name = 60)
  const hugeName = "A".repeat(65);
  const res = await fetch(`http://127.0.0.1:${port}/accounts/edit`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: hugeName, bio: "normal" }),
    redirect: "manual",
  });

  assert.equal(res.status, 400);

  await new Promise((ok) => server.close(ok));
});

test("POST /accounts/edit validates bio length limit", async () => {
  const app = express();
  app.set("view engine", "ejs");
  app.engine("ejs", (path, data, cb) => cb(null, "render-stub"));

  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.me = { id: "user-1", username: "bob", name: "Bob", bio: "Hello" };
    next();
  });
  app.use(createSettingsRouter({
    store: {},
    storeImage: async () => "",
    media: (req, res, next) => next(),
    needLogin,
  }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  // Bio exceeding 150 chars
  const hugeBio = "B".repeat(160);
  const res = await fetch(`http://127.0.0.1:${port}/accounts/edit`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "Bob", bio: hugeBio }),
    redirect: "manual",
  });

  assert.equal(res.status, 400);

  await new Promise((ok) => server.close(ok));
});

test("POST /accounts/edit updates user and redirects to profile", async () => {
  let updatedValues = null;
  const mockStore = {
    async updateUser(id, vals) {
      updatedValues = vals;
    },
  };

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.me = { id: "user-1", username: "bob", name: "Bob", bio: "Hello" };
    next();
  });
  app.use(createSettingsRouter({
    store: mockStore,
    storeImage: async () => "",
    media: (req, res, next) => next(),
    needLogin,
  }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/accounts/edit`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "Robert", bio: "Updated bio here." }),
    redirect: "manual",
  });

  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/bob");
  assert.deepEqual(updatedValues, { name: "Robert", bio: "Updated bio here." });

  await new Promise((ok) => server.close(ok));
});


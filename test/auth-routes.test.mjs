import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createAuthRouter } from "../routes/auth.routes.mjs";
import * as auth from "../lib/auth.mjs";

const TEST_SECRET = "auth-routes-test-secret-123456";

test("GET /login redirects logged-in user to home feed", async () => {
  const app = express();
  app.use((req, res, next) => {
    req.me = { id: "user-1", username: "bob" };
    next();
  });
  app.use(createAuthRouter({ store: {}, secret: TEST_SECRET }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/login`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");

  await new Promise((ok) => server.close(ok));
});

test("GET /signup redirects logged-in user to home feed", async () => {
  const app = express();
  app.use((req, res, next) => {
    req.me = { id: "user-1", username: "bob" };
    next();
  });
  app.use(createAuthRouter({ store: {}, secret: TEST_SECRET }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/signup`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");

  await new Promise((ok) => server.close(ok));
});

test("POST /logout clears cookie and redirects to /login", async () => {
  const app = express();
  app.use(createAuthRouter({ store: {}, secret: TEST_SECRET }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/logout`, { method: "POST", redirect: "manual" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/login");
  const cleared = res.headers.getSetCookie().find((c) => c.startsWith("sid="));
  assert.ok(cleared, "sid cookie must be cleared");

  await new Promise((ok) => server.close(ok));
});

test("POST /appearance updates theme cookie", async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(createAuthRouter({ store: {}, secret: TEST_SECRET }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/appearance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ theme: "dark" }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.theme, "dark");
  const themeCookie = res.headers.getSetCookie().find((c) => c.startsWith("theme="));
  assert.match(themeCookie, /dark/);

  await new Promise((ok) => server.close(ok));
});

// Tests for routes/legacy.routes.mjs
// Verifies every v1 URL produces HTTP 301 and the correct Location header,
// including URL-encoding of path segments with special characters.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createLegacyRouter } from "../routes/legacy.routes.mjs";

function buildApp() {
  const app = express();
  app.use(createLegacyRouter());
  return app;
}

async function request(app, method, path) {
  return new Promise((resolve) => {
    const req = { method: method.toUpperCase(), url: path, headers: { host: "localhost" } };
    const res = {
      _status: 200,
      _headers: {},
      status(code) { this._status = code; return this; },
      setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
      getHeader(k) { return this._headers[k.toLowerCase()]; },
      end() { resolve({ status: this._status, headers: this._headers }); },
    };
    // Use supertest-lite: inject into express
    app(Object.assign(req, {
      socket: { remoteAddress: "127.0.0.1" },
      connection: { remoteAddress: "127.0.0.1" },
      get(h) { return this.headers[h.toLowerCase()] ?? ""; },
    }), Object.assign(res, {
      redirect(code, url) {
        this._status = typeof code === "number" ? code : 302;
        const loc = typeof code === "number" ? url : code;
        this._headers["location"] = loc;
        this.end();
      },
      send() { this.end(); },
      json() { this.end(); },
    }), () => {
      res._status = 404;
      res.end();
    });
  });
}

// Prefer supertest for clean HTTP assertions
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";

function superGet(app, path) {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const req = httpRequest(
        { hostname: "127.0.0.1", port, path, method: "GET" },
        (res) => {
          res.resume();
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, location: res.headers["location"] ?? "" });
          });
        }
      );
      req.on("error", (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

describe("Legacy redirect routes", () => {
  const app = buildApp();

  it("GET /posts → 301 /", async () => {
    const r = await superGet(app, "/posts");
    assert.equal(r.status, 301);
    assert.equal(r.location, "/");
  });

  it("GET /posts/new → 301 /create", async () => {
    const r = await superGet(app, "/posts/new");
    assert.equal(r.status, 301);
    assert.equal(r.location, "/create");
  });

  it("GET /posts/:id → 301 /p/:id (plain UUID)", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const r = await superGet(app, `/posts/${id}`);
    assert.equal(r.status, 301);
    assert.equal(r.location, `/p/${encodeURIComponent(id)}`);
  });

  it("GET /posts/:id/edit → 301 /p/:id/edit (plain UUID)", async () => {
    const id = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";
    const r = await superGet(app, `/posts/${id}/edit`);
    assert.equal(r.status, 301);
    assert.equal(r.location, `/p/${encodeURIComponent(id)}/edit`);
  });

  it("GET /reel/:id → 301 /reels?start=:id", async () => {
    const id = "deadbeef-cafe-babe-feed-c0ffee000000";
    const r = await superGet(app, `/reel/${id}`);
    assert.equal(r.status, 301);
    assert.equal(r.location, `/reels?start=${encodeURIComponent(id)}`);
  });

  it("GET /posts/:id handles URL-unsafe characters in id", async () => {
    // Express router captures the segment before the slash, so an id with
    // a slash would be a different route; test ids with other special chars.
    const id = "my post+id=1&x=2";
    const r = await superGet(app, `/posts/${encodeURIComponent(id)}`);
    assert.equal(r.status, 301);
    // Location must re-encode the already-decoded param value
    assert.equal(r.location, `/p/${encodeURIComponent(id)}`);
  });

  it("GET /reel/:id handles URL-unsafe characters in id", async () => {
    const id = "track name+remix";
    const r = await superGet(app, `/reel/${encodeURIComponent(id)}`);
    assert.equal(r.status, 301);
    assert.equal(r.location, `/reels?start=${encodeURIComponent(id)}`);
  });

  it("non-legacy route falls through to 404", async () => {
    const r = await superGet(app, "/old-posts/something");
    assert.equal(r.status, 404);
  });
});


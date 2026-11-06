import { test } from "node:test";
import assert from "node:assert/strict";
import * as authLib from "../lib/auth.mjs";
import {
  createAuthContextMiddleware,
  needLogin,
  loginUser,
  logoutUser,
} from "../middleware/auth.mjs";

const TEST_SECRET = "test-secret-key-1234567890";

test("createAuthContextMiddleware populates req.me and res.locals for valid signed session", async () => {
  const mockUser = { id: "user-123", username: "alice", name: "Alice" };
  const mockStore = {
    async userById(id) {
      return id === "user-123" ? mockUser : null;
    },
    async unreadThreads() {
      return 3;
    },
  };

  const middleware = createAuthContextMiddleware({ store: mockStore, secret: TEST_SECRET });
  const validToken = authLib.sessionToken("user-123", TEST_SECRET);

  const req = {
    get: (h) => (h.toLowerCase() === "cookie" ? `${authLib.SESSION_COOKIE}=${validToken}` : ""),
    originalUrl: "/feed",
    method: "GET",
    query: {},
  };
  const res = {
    locals: {},
    clearCookie() {},
  };

  let nextCalled = false;
  await new Promise((resolve) => {
    middleware(req, res, () => {
      nextCalled = true;
      resolve();
    });
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.me, mockUser);
  assert.deepEqual(res.locals.me, mockUser);
  assert.equal(res.locals.unread, 3);
  assert.equal(res.locals.theme, "system");
});

test("createAuthContextMiddleware handles unauthenticated requests cleanly", async () => {
  const mockStore = {
    async userById() {
      return null;
    },
    async unreadThreads() {
      return 0;
    },
  };

  const middleware = createAuthContextMiddleware({ store: mockStore, secret: TEST_SECRET });

  const req = {
    get: () => "",
    originalUrl: "/",
    method: "GET",
    query: {},
  };
  const res = {
    locals: {},
    clearCookie() {},
  };

  let nextCalled = false;
  await new Promise((resolve) => {
    middleware(req, res, () => {
      nextCalled = true;
      resolve();
    });
  });

  assert.equal(nextCalled, true);
  assert.equal(req.me, null);
  assert.equal(res.locals.me, null);
  assert.equal(res.locals.unread, 0);
});

test("createAuthContextMiddleware rejects tampered session tokens", async () => {
  let userByIdCalled = false;
  const mockStore = {
    async userById() {
      userByIdCalled = true;
      return null;
    },
    async unreadThreads() {
      return 0;
    },
  };

  const middleware = createAuthContextMiddleware({ store: mockStore, secret: TEST_SECRET });
  const validToken = authLib.sessionToken("user-123", TEST_SECRET);
  // Tamper with signature portion
  const tamperedToken = validToken.slice(0, -4) + "XXXX";

  const req = {
    get: (h) => (h.toLowerCase() === "cookie" ? `${authLib.SESSION_COOKIE}=${tamperedToken}` : ""),
    originalUrl: "/",
    method: "GET",
    query: {},
  };
  const res = {
    locals: {},
    clearCookie() {},
  };

  let nextCalled = false;
  await new Promise((resolve) => {
    middleware(req, res, () => {
      nextCalled = true;
      resolve();
    });
  });

  assert.equal(nextCalled, true);
  assert.equal(req.me, null);
  assert.equal(res.locals.me, null);
  assert.equal(userByIdCalled, false, "Store should not be queried for tampered session tokens");
});

test("createAuthContextMiddleware rejects expired session tokens", async () => {
  const mockStore = {
    async userById() {
      return null;
    },
    async unreadThreads() {
      return 0;
    },
  };

  const middleware = createAuthContextMiddleware({ store: mockStore, secret: TEST_SECRET });
  // Timestamp from 40 days ago (SESSION_DAYS is 30)
  const expiredToken = authLib.sessionToken("user-123", TEST_SECRET, Date.now() - 40 * 86_400_000);

  const req = {
    get: (h) => (h.toLowerCase() === "cookie" ? `${authLib.SESSION_COOKIE}=${expiredToken}` : ""),
    originalUrl: "/",
    method: "GET",
    query: {},
  };
  const res = {
    locals: {},
    clearCookie() {},
  };

  let nextCalled = false;
  await new Promise((resolve) => {
    middleware(req, res, () => {
      nextCalled = true;
      resolve();
    });
  });

  assert.equal(nextCalled, true);
  assert.equal(req.me, null);
});

test("needLogin allows authenticated requests", () => {
  let nextCalled = false;
  const req = { me: { id: "user-123" } };
  const res = {};
  needLogin(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test("needLogin redirects browser requests to /login?next=...", () => {
  let redirectedStatus = null;
  let redirectedUrl = null;

  const req = {
    me: null,
    method: "GET",
    originalUrl: "/accounts/edit",
    get: () => "text/html",
  };
  const res = {
    redirect(status, url) {
      redirectedStatus = status;
      redirectedUrl = url;
    },
  };

  needLogin(req, res, () => {});
  assert.equal(redirectedStatus, 303);
  assert.equal(redirectedUrl, "/login?next=%2Faccounts%2Fedit");
});

test("needLogin returns 401 JSON for API requests", () => {
  let statusSet = null;
  let jsonSent = null;

  const req = {
    me: null,
    method: "POST",
    originalUrl: "/p/123/like",
    get: (h) => (h.toLowerCase() === "accept" ? "application/json" : ""),
  };
  const res = {
    status(s) {
      statusSet = s;
      return {
        json(data) {
          jsonSent = data;
        },
      };
    },
  };

  needLogin(req, res, () => {});
  assert.equal(statusSet, 401);
  assert.deepEqual(jsonSent, { error: "Log in to continue.", login: "/login" });
});

test("loginUser sets signed cookie with strict security attributes", () => {
  let cookieName = null;
  let cookieVal = null;
  let cookieOpts = null;

  const req = { secure: true };
  const res = {
    cookie(name, val, opts) {
      cookieName = name;
      cookieVal = val;
      cookieOpts = opts;
    },
  };

  loginUser(req, res, "user-abc", TEST_SECRET);

  assert.equal(cookieName, authLib.SESSION_COOKIE);
  assert.equal(authLib.readSession(cookieVal, TEST_SECRET), "user-abc");
  assert.equal(cookieOpts.httpOnly, true);
  assert.equal(cookieOpts.sameSite, "lax");
  assert.equal(cookieOpts.secure, true);
  assert.equal(cookieOpts.path, "/");
  assert.equal(cookieOpts.maxAge, authLib.SESSION_DAYS * 86_400_000);
});

test("logoutUser clears the session cookie with root path", () => {
  let clearedCookieName = null;
  let clearedOpts = null;

  const res = {
    clearCookie(name, opts) {
      clearedCookieName = name;
      clearedOpts = opts;
    },
  };

  logoutUser(res);
  assert.equal(clearedCookieName, authLib.SESSION_COOKIE);
  assert.deepEqual(clearedOpts, { path: "/" });
});

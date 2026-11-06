import { test } from "node:test";
import assert from "node:assert/strict";
import { CSP, securityHeaders, csrfOriginCheck } from "../middleware/security.mjs";

test("securityHeaders sets all strict security headers on response", () => {
  const req = {};
  const headers = {};
  const res = {
    set(map) {
      Object.assign(headers, map);
    },
  };
  let nextCalled = false;
  securityHeaders(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(headers["Content-Security-Policy"], CSP);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(headers["Cross-Origin-Opener-Policy"], "same-origin");
  assert.equal(headers["Permissions-Policy"], "camera=(), microphone=(), geolocation=()");
});

test("csrfOriginCheck allows safe HTTP methods regardless of Origin", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    let nextCalled = false;
    const req = {
      method,
      get: (h) => (h.toLowerCase() === "origin" ? "https://evil.com" : ""),
    };
    const res = {};
    csrfOriginCheck(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true, `Expected method ${method} to pass without blocking`);
  }
});

test("csrfOriginCheck allows state-changing requests when no Origin or Referer is present", () => {
  let nextCalled = false;
  const req = {
    method: "POST",
    get: () => "",
  };
  const res = {};
  csrfOriginCheck(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test("csrfOriginCheck allows requests with matching Host in Origin", () => {
  let nextCalled = false;
  const req = {
    method: "POST",
    get: (h) => {
      if (h.toLowerCase() === "origin") return "http://localhost:8080";
      if (h.toLowerCase() === "host") return "localhost:8080";
      return "";
    },
  };
  const res = {};
  csrfOriginCheck(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test("csrfOriginCheck allows requests with matching Host in Referer", () => {
  let nextCalled = false;
  const req = {
    method: "POST",
    get: (h) => {
      if (h.toLowerCase() === "referer") return "http://localhost:8080/p/123";
      if (h.toLowerCase() === "host") return "localhost:8080";
      return "";
    },
  };
  const res = {};
  csrfOriginCheck(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test("csrfOriginCheck blocks state-changing requests from foreign Origin with 403", () => {
  let nextCalled = false;
  let statusSet = null;
  let responseSent = null;

  const req = {
    method: "POST",
    get: (h) => {
      if (h.toLowerCase() === "origin") return "https://evil.attacker.com";
      if (h.toLowerCase() === "host") return "localhost:8080";
      return "";
    },
  };
  const res = {
    status(s) {
      statusSet = s;
      return {
        send(msg) {
          responseSent = msg;
        },
      };
    },
  };

  csrfOriginCheck(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(statusSet, 403);
  assert.match(responseSent, /This request came from another website/);
});

test("csrfOriginCheck blocks state-changing requests with foreign Referer with 403", () => {
  let nextCalled = false;
  let statusSet = null;
  let responseSent = null;

  const req = {
    method: "POST",
    get: (h) => {
      if (h.toLowerCase() === "referer") return "https://evil.attacker.com/page";
      if (h.toLowerCase() === "host") return "localhost:8080";
      return "";
    },
  };
  const res = {
    status(s) {
      statusSet = s;
      return {
        send(msg) {
          responseSent = msg;
        },
      };
    },
  };

  csrfOriginCheck(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(statusSet, 403);
  assert.match(responseSent, /This request came from another website/);
});

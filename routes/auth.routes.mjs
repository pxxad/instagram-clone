// Authentication and session routes: login, signup, logout, and appearance preferences.
import { Router } from "express";
import { randomUUID } from "node:crypto";
import * as auth from "../lib/auth.mjs";
import * as text from "../lib/text.mjs";
import { route, str, localPath, flash, done } from "../lib/http-helpers.mjs";
import { loginUser, logoutUser } from "../middleware/auth.mjs";

/**
 * Creates the authentication and appearance router.
 * Handles:
 * - GET /login: Renders the login page with preview photos from explore.
 * - POST /login: Verifies credentials, applies brute-force rate-limiting, and issues session cookie.
 * - GET /signup: Renders user registration form.
 * - POST /signup: Validates username/password/name, creates account, hashes password, and logs in.
 * - POST /logout: Clears the session cookie and redirects to /login.
 * - POST /appearance: Updates theme preference ("light", "dark", "system") in cookie.
 */
export function createAuthRouter({ store, secret, limiter = auth.loginLimiter() }) {
  const router = Router();

  async function loginPage(req, res, { status = 200, error = "", username = "" } = {}) {
    const photos = (await store.explore("", { limit: 6 }))
      .filter((p) => p.kind === "photo")
      .slice(0, 4)
      .map((p) => p.image);
    res.status(status).render("login", {
      title: "Login",
      error,
      username,
      next: localPath(req.query.next || req.body?.next),
      photos,
    });
  }

  router.get("/login", route(async (req, res) => (req.me ? res.redirect("/") : loginPage(req, res))));

  router.post("/login", route(async (req, res) => {
    const username = str(req.body.username).toLowerCase().replace(/^@/, "");
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const key = `${req.ip} ${username}`;
    const wait = limiter.wait(key);
    if (wait) {
      return loginPage(req, res, {
        status: 429,
        username,
        error: `Too many failed attempts. Try again in ${text.plural(wait, "minute")}.`,
      });
    }

    const account = username ? await store.credentials(username) : null;
    const ok = account ? await auth.verifyPassword(password, account.passwordHash) : await auth.wasteTime(password);
    if (!ok) {
      limiter.fail(key);
      return loginPage(req, res, {
        status: 401,
        username,
        error: "The username or password is incorrect. Check them and try again.",
      });
    }

    limiter.clear(key);
    loginUser(req, res, account.id, secret);
    res.redirect(303, localPath(req.body.next) || "/");
  }));

  router.get("/signup", (req, res) => (req.me ? res.redirect("/") : res.render("signup", { title: "Sign up", errors: {}, values: {} })));

  router.post("/signup", route(async (req, res) => {
    const values = { name: str(req.body.name), username: str(req.body.username).toLowerCase().replace(/^@/, "") };
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const errors = {};

    if (!text.USERNAME.test(values.username)) {
      errors.username = "Usernames can use letters, numbers, underscores and periods (up to 30), and can't start or end with a period.";
    } else if (text.RESERVED.has(values.username)) {
      errors.username = "This username isn't available. Try another.";
    }

    if (text.length(values.name) > text.LIMITS.name) {
      errors.name = `Names can be up to ${text.LIMITS.name} characters.`;
    }
    if (password.length < text.LIMITS.password) {
      errors.password = `Use at least ${text.LIMITS.password} characters for your password.`;
    }

    if (!errors.username && (await store.userByUsername(values.username))) {
      errors.username = "This username isn't available. Try another.";
    }

    if (Object.keys(errors).length) {
      return res.status(400).render("signup", { title: "Sign up", errors, values });
    }

    const id = randomUUID();
    try {
      await store.createUser({ id, ...values, passwordHash: await auth.hashPassword(password) });
    } catch (err) {
      if (err.code !== "TAKEN") throw err;
      return res.status(400).render("signup", {
        title: "Sign up",
        errors: { username: "This username isn't available. Try another." },
        values,
      });
    }

    loginUser(req, res, id, secret);
    flash(req, res, `Welcome, @${values.username}! Follow a few accounts to fill your feed.`);
    res.redirect(303, "/");
  }));

  router.post("/logout", (req, res) => {
    logoutUser(res);
    res.redirect(303, "/login");
  });

  router.post("/appearance", (req, res) => {
    const theme = ["light", "dark"].includes(req.body.theme) ? req.body.theme : "system";
    if (theme === "system") res.clearCookie("theme", { path: "/" });
    else res.cookie("theme", theme, { sameSite: "lax", path: "/", maxAge: 365 * 86_400_000 });
    done(req, res, { theme }, "/");
  });

  return router;
}

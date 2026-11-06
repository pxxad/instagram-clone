// Account settings routes: edit profile information, bio, and avatar.
import { Router } from "express";
import * as text from "../lib/text.mjs";
import { route, str, flash } from "../lib/http-helpers.mjs";
import { discard, takeUpload } from "../middleware/upload.mjs";

/**
 * Creates the account settings router.
 * Handles:
 * - GET /accounts/edit: Renders the edit profile view populated with current user details.
 * - POST /accounts/edit: Validates name length, bio length, processes avatar image upload,
 *   updates the user record, and redirects back to the user's profile.
 */
export function createSettingsRouter({ store, storeImage, media, needLogin }) {
  const router = Router();

  router.get("/accounts/edit", needLogin, (req, res) =>
    res.render("settings", { title: "Edit profile", values: req.me, error: "" }));

  router.post("/accounts/edit", needLogin, media, route(async (req, res) => {
    const values = { name: str(req.body.name), bio: str(req.body.bio).replace(/\r\n/g, "\n") };
    let error = "";

    if (text.length(values.name) > text.LIMITS.name) {
      error = `Names can be up to ${text.LIMITS.name} characters.`;
    } else if (text.length(values.bio) > text.LIMITS.bio) {
      error = `Bios can be up to ${text.LIMITS.bio} characters.`;
    }

    if (!error && (req.media || req.uploadError)) {
      const image = await takeUpload(req, { allowVideo: false, storeImage });
      if (image.error) error = image.error;
      else values.avatar = image.url;
    }

    if (req.body.removePhoto === "1" && !values.avatar) values.avatar = "";

    if (error) {
      await discard(req.media, req.poster);
      return res.status(400).render("settings", {
        title: "Edit profile",
        values: { ...req.me, ...values },
        error,
      });
    }

    await discard(req.poster);
    await store.updateUser(req.me.id, values);
    flash(req, res, "Profile saved.");
    res.redirect(303, `/${req.me.username}`);
  }));

  return router;
}


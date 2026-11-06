// Posts routes: creation, viewing, editing, deletion, and reactions (likes, saves, reposts).
import { Router } from "express";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as text from "../lib/text.mjs";
import {
  UUID,
  route,
  flash,
  wantsJson,
  str,
  done,
  notFound,
  trackId,
} from "../lib/http-helpers.mjs";
import { sniff, discard, takeUpload as takeUploadCore } from "../middleware/upload.mjs";

const KINDS = ["post", "reel", "story"];

/**
 * Creates the posts router.
 * Handles:
 * - GET /create: Render post/reel/story creation form.
 * - POST /p: Process uploaded media and create a photo post, video reel, or story.
 * - GET /p/:id: Detail view of a post with comments, user post preview, and follow status.
 * - GET /p/:id/edit: Edit form for post owner.
 * - PATCH /p/:id: Update caption, alt text, filter, aspect, or audio track.
 * - DELETE /p/:id: Delete post and clean up associated upload files on disk.
 * - POST/DELETE /p/:id/like: Like or unlike a post.
 * - POST/DELETE /p/:id/save: Save or unsave a post.
 * - POST/DELETE /p/:id/repost: Repost or unrepost someone else's post.
 */
export function createPostsRouter({
  store,
  storeImage,
  media,
  needLogin,
  uploadDir,
  findPost = async (req) => (UUID.test(req.params.id) ? store.getPost(req.params.id, req.me?.id ?? "") : null),
}) {
  const router = Router();
  const takeUpload = (req, opts) => takeUploadCore(req, { ...opts, storeImage });

  const createForm = (req, res, { status = 200, error = "", values = {} } = {}) =>
    res.status(status).render("create", {
      title: "Create",
      active: "create",
      error,
      values: {
        kind: KINDS.includes(req.query.kind) ? req.query.kind : "post",
        caption: "",
        alt: "",
        filter: "normal",
        aspect: "square",
        music: trackId(req.query.music),
        ...values,
      },
    });

  // ---- Creation --------------------------------------------------------------------------
  router.get("/create", needLogin, (req, res) => createForm(req, res));

  router.post("/p", needLogin, media, route(async (req, res) => {
    const values = {
      kind: KINDS.includes(req.body.kind) ? req.body.kind : "post",
      caption: str(req.body.caption),
      alt: str(req.body.alt),
      filter: text.FILTER_IDS.has(req.body.filter) ? req.body.filter : "normal",
      aspect: text.ASPECT_IDS.has(req.body.aspect) ? req.body.aspect : "square",
      music: trackId(req.body.music),
    };

    const fail = async (error) => {
      await discard(req.media, req.poster);
      return createForm(req, res, { status: 400, error, values });
    };

    if (text.length(values.caption) > text.LIMITS.caption) {
      return fail(`Captions can be up to ${text.count(text.LIMITS.caption)} characters.`);
    }
    if (text.length(values.alt) > text.LIMITS.alt) {
      return fail(`Alt text can be up to ${text.LIMITS.alt} characters.`);
    }

    const upload = await takeUpload(req, { allowVideo: values.kind !== "story" });
    if (upload.error) return fail(upload.error);

    const id = randomUUID();

    if (values.kind === "story") {
      await discard(req.poster);
      await store.createStory({ id, userId: req.me.id, image: upload.url, music: values.music });
      flash(req, res, "Your story is up for the next 24 hours.");
      return res.redirect(303, "/");
    }

    if (upload.kind === "video") {
      // Every video is a reel (as on Instagram). The page sends a still from the video as its poster.
      let poster = "";
      if (req.poster) {
        if ((await sniff(req.poster)) === "image") poster = await storeImage(req.poster);
        else await discard(req.poster);
      }
      await store.createPost({
        id,
        userId: req.me.id,
        kind: "reel",
        image: poster,
        video: upload.url,
        music: values.music,
        caption: values.caption,
        alt: values.alt,
        filter: values.filter,
        aspect: "vertical",
      });
      flash(req, res, "Your reel has been shared.");
      return res.redirect(303, `/p/${id}`);
    }

    if (values.kind === "reel") {
      await discard(req.poster);
      return fail("Reels are videos. Choose an MP4, WebM or MOV file, or share this photo as a post.");
    }

    await discard(req.poster);
    const { kind, ...post } = values;
    await store.createPost({ id, userId: req.me.id, image: upload.url, ...post });
    flash(req, res, "Your post has been shared.");
    res.redirect(303, `/p/${id}`);
  }));

  // ---- Viewing, Editing & Deleting -------------------------------------------------------
  router.get("/p/:id", route(async (req, res) => {
    const post = await findPost(req);
    if (!post) return notFound(res);
    const viewer = req.me?.id ?? "";
    const [comments, more, following] = await Promise.all([
      store.comments(post.id),
      store.userPosts(post.user.id, viewer, { limit: 7 }),
      req.me ? store.isFollowing(req.me.id, post.user.id) : false,
    ]);
    const quote = text.length(post.caption) > 60 ? [...post.caption].slice(0, 60).join("") + "…" : post.caption;
    res.render("post", {
      title: `${post.user.name || post.user.username} on Instagram: “${quote}”`,
      post,
      comments,
      following,
      more: more.filter((p) => p.id !== post.id).slice(0, 6),
    });
  }));

  const ownPost = async (req, res) => {
    const post = await findPost(req);
    if (!post) notFound(res);
    else if (post.user.id !== req.me.id) res.status(403).send("Only the person who shared this post can change it.");
    else return post;
  };

  router.get("/p/:id/edit", needLogin, route(async (req, res) => {
    const post = await ownPost(req, res);
    if (post) res.render("edit", { title: "Edit post", post, error: "" });
  }));

  router.patch("/p/:id", needLogin, route(async (req, res) => {
    const post = await ownPost(req, res);
    if (!post) return;
    const fields = {};
    for (const k of ["caption", "alt"]) if (typeof req.body[k] === "string") fields[k] = str(req.body[k]);
    if (text.FILTER_IDS.has(req.body.filter)) fields.filter = req.body.filter;
    if (post.kind === "photo" && text.ASPECT_IDS.has(req.body.aspect)) fields.aspect = req.body.aspect;
    if (typeof req.body.music === "string") fields.music = trackId(req.body.music);

    let error = "";
    if (text.length(fields.caption ?? "") > text.LIMITS.caption) {
      error = `Captions can be up to ${text.count(text.LIMITS.caption)} characters.`;
    } else if (text.length(fields.alt ?? "") > text.LIMITS.alt) {
      error = `Alt text can be up to ${text.LIMITS.alt} characters.`;
    }

    if (error) return res.status(400).render("edit", { title: "Edit post", post: { ...post, ...fields }, error });
    await store.updatePost(post.id, fields);
    flash(req, res, "Post updated.");
    res.redirect(303, `/p/${post.id}`);
  }));

  router.delete("/p/:id", needLogin, route(async (req, res) => {
    const post = await ownPost(req, res);
    if (!post) return;
    await store.removePost(post.id);
    // Uploads kept on this server go with the post (files on Imgur stay there).
    const ours = [post.image, post.video].filter((url) => typeof url === "string" && /^\/uploads\/[\w-]+\.\w+$/.test(url));
    if (uploadDir) {
      await Promise.all(ours.map((url) => unlink(path.join(uploadDir, path.basename(url))).catch(() => {})));
    }
    if (wantsJson(req)) return res.json({ deleted: true });
    flash(req, res, "Post deleted.");
    res.redirect(303, `/${req.me.username}`);
  }));

  // ---- Likes, Saves & Reposts -------------------------------------------------------------
  const toggle = (act) => [needLogin, route(async (req, res) => {
    const post = await findPost(req);
    if (!post) return wantsJson(req) ? res.status(404).json({ error: "This post was deleted." }) : notFound(res);
    const result = await act(req.me.id, post);
    if (result.error) return wantsJson(req) ? res.status(400).json(result) : res.status(400).send(result.error);
    done(req, res, result, `/p/${post.id}`);
  })];

  router.post("/p/:id/like", ...toggle(async (me, p) => ({ liked: true, like_count: await store.like(me, p.id) })));
  router.delete("/p/:id/like", ...toggle(async (me, p) => ({ liked: false, like_count: await store.unlike(me, p.id) })));
  router.post("/p/:id/save", ...toggle(async (me, p) => (await store.save(me, p.id), { saved: true })));
  router.delete("/p/:id/save", ...toggle(async (me, p) => (await store.unsave(me, p.id), { saved: false })));
  router.post("/p/:id/repost", ...toggle(async (me, p) =>
    p.user.id === me ? { error: "You can't repost your own post." } : { reposted: true, repost_count: await store.repost(me, p.id) }));
  router.delete("/p/:id/repost", ...toggle(async (me, p) => ({ reposted: false, repost_count: await store.unrepost(me, p.id) })));

  return router;
}

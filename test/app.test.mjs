// End-to-end tests over HTTP: the real Express app and views with the demo data in the in-memory
// store (no MySQL needed). Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, PAGE_SIZE } from "../app.mjs";
import { memoryStore } from "../store/memory.mjs";
import { mysqlStore } from "../store/mysql.mjs";
import { DEMO, seedStore } from "../seed.mjs";
import { imageStore } from "../images.mjs";
import * as auth from "../lib/auth.mjs";
import * as text from "../lib/text.mjs";
import { TRACKS } from "../lib/music.mjs";

const SECRET = "test-secret";
let server, base, store, data, uploadDir;
const stored = [];

before(async () => {
  uploadDir = await mkdtemp(path.join(tmpdir(), "insta-uploads-"));
  store = memoryStore();
  data = await seedStore(store);
  const app = createApp({
    store,
    secret: SECRET,
    demo: DEMO,
    uploadDir,
    // Like images.mjs with an Imgur key: photos go to "Imgur", videos stay on this server.
    storeImage: async (file) => {
      stored.push(file);
      return file.mimetype.startsWith("video/") ? `/uploads/${file.filename}` : `https://i.imgur.test/${file.filename}`;
    },
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(uploadDir, { recursive: true, force: true });
});

/** A browser-like client that keeps its session cookie. */
function client() {
  const jar = new Map();
  async function request(url, { method = "GET", body, json = false, headers = {} } = {}) {
    const res = await fetch(base + url, {
      method,
      body: body instanceof FormData ? body : body && new URLSearchParams(body),
      redirect: "manual",
      headers: {
        ...(json && { Accept: "application/json" }),
        ...(jar.size && { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }),
        ...headers,
      },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, v] = pair.split("=");
      if (/Expires=Thu, 01 Jan 1970/.test(c) || !v) jar.delete(k);
      else jar.set(k, v);
    }
    const textBody = await res.text();
    return { status: res.status, location: res.headers.get("location"), headers: res.headers, body: textBody, json: () => JSON.parse(textBody) };
  }
  return { request, jar, login: (username = DEMO.username, password = DEMO.password) => request("/login", { method: "POST", body: { username, password } }) };
}

const demoId = () => data.users.find((u) => u.username === DEMO.username).id;
const postIds = (html) => [...html.matchAll(/<article class="post" data-post="([^"]+)"/g)].map((m) => m[1]);
const png = (name = "photo.png") => new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)], name, { type: "image/png" });
const jpeg = (name = "poster.jpg") => new File([Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1)], name, { type: "image/jpeg" });
const mp4 = (name = "clip.mp4") => new File([Uint8Array.of(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0)], name, { type: "video/mp4" });
const newAccount = async (username) => {
  const c = client();
  await c.request("/signup", { method: "POST", body: { name: username, username, password: "longenough" } });
  return c;
};

/** Reads a Server-Sent Events stream as the given client, one event at a time. */
async function events(c) {
  const abort = new AbortController();
  const res = await fetch(`${base}/direct/events`, { headers: { Cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join("; ") }, signal: abort.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    headers: res.headers,
    async next(type) {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (/^event: (\w+)/m.exec(chunk)?.[1] === type) return JSON.parse(/^data: (.*)$/m.exec(chunk)[1]);
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed");
        buffer += decoder.decode(value);
      }
    },
    close: () => abort.abort(),
  };
}

// ---- Logged out ---------------------------------------------------------------------------------------

test("logged out: the feed sends you to the login page; explore, profiles and posts are public", async () => {
  const c = client();
  assert.deepEqual([(await c.request("/")).status, (await c.request("/")).location], [302, "/login"]);
  const login = await c.request("/login");
  assert.equal(login.status, 200);
  assert.match(login.body, /Log in with the demo account/);
  assert.equal((await c.request("/explore")).status, 200);
  const profile = await c.request(`/${DEMO.username}`);
  assert.equal(profile.status, 200);
  assert.match(profile.body, /href="\/login\?next=\/demo"/);
  const post = await c.request(`/p/${data.posts[0].id}`);
  assert.equal(post.status, 200);
  assert.match(post.body, /to like or comment/);
  const like = await c.request(`/p/${data.posts[0].id}/like`, { method: "POST", json: true });
  assert.equal(like.status, 401);
  const create = await c.request("/create");
  assert.equal(create.status, 303);
  assert.equal(create.location, "/login?next=%2Fcreate");
});

// ---- Accounts --------------------------------------------------------------------------------------------

test("sign up checks the username and password, then logs you in", async () => {
  const c = client();
  const bad = await c.request("/signup", { method: "POST", body: { name: "X", username: ".bad..name", password: "longenough" } });
  assert.equal(bad.status, 400);
  assert.match(bad.body, /can&#39;t start or end with a period/);
  const reserved = await c.request("/signup", { method: "POST", body: { name: "X", username: "explore", password: "longenough" } });
  assert.match(reserved.body, /isn&#39;t available/);
  const taken = await c.request("/signup", { method: "POST", body: { name: "X", username: DEMO.username, password: "longenough" } });
  assert.match(taken.body, /isn&#39;t available/);
  const short = await c.request("/signup", { method: "POST", body: { name: "X", username: "newbie", password: "short" } });
  assert.match(short.body, /at least 8 characters/);
  const ok = await c.request("/signup", { method: "POST", body: { name: "New Person", username: "@NewBie", password: "correct horse" } });
  assert.equal(ok.status, 303);
  assert.ok(c.jar.has("sid"));
  const home = await c.request("/");
  assert.equal(home.status, 200);
  assert.match(home.body, /Welcome to Instagram/, "a new account follows nobody yet, so it sees suggestions");
  assert.match(home.body, /Welcome, @newbie!/, "the welcome message is shown once");
  assert.doesNotMatch((await c.request("/")).body, /Welcome, @newbie!/);
  const again = client();
  assert.equal((await again.login("newbie", "correct horse")).status, 303);
});

test("log in: a wrong password is refused without saying which part was wrong; 10 failures lock it for 15 minutes", async () => {
  const c = client();
  const wrong = await c.login(DEMO.username, "nope");
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /username or password is incorrect/);
  const unknown = await c.login("nobody_here", "nope");
  assert.match(unknown.body, /username or password is incorrect/);
  for (let i = 0; i < 9; i++) await c.login("nobody_here", "nope");
  const locked = await c.login("nobody_here", "nope");
  assert.equal(locked.status, 429);
  assert.match(locked.body, /Try again in 15 minutes/);
  const ok = await c.login();
  assert.equal(ok.status, 303, "other usernames are not locked");
  assert.equal(ok.location, "/");
  const next = await client().request("/login", { method: "POST", body: { ...DEMO, next: "/explore" } });
  assert.equal(next.location, "/explore");
  const offsite = await client().request("/login", { method: "POST", body: { ...DEMO, next: "//evil.example" } });
  assert.equal(offsite.location, "/", "only links on this site are followed after logging in");
});

test("session cookies are signed: a changed cookie logs you out; logging out clears it", async () => {
  const c = client();
  await c.login();
  const [id, issued, sig] = c.jar.get("sid").split(".");
  const other = data.users[5].id;
  c.jar.set("sid", `${other}.${issued}.${sig}`);
  assert.equal((await c.request("/")).status, 302);
  c.jar.set("sid", `${id}.${issued}.${sig}`);
  assert.equal((await c.request("/")).status, 200);
  await c.request("/logout", { method: "POST" });
  assert.ok(!c.jar.has("sid"));
  assert.equal((await c.request("/")).status, 302);
});

// ---- Feed --------------------------------------------------------------------------------------------------

test("home feed: people you follow (and you), newest first, in pages with no repeats", async () => {
  const c = client();
  await c.login();
  const first = await c.request("/");
  const ids = postIds(first.body);
  assert.equal(ids.length, PAGE_SIZE);
  const followed = new Set(data.follows.filter((f) => f.follower_id === demoId()).map((f) => f.followee_id).concat(demoId()));
  const byId = new Map(data.posts.map((p) => [p.id, p]));
  // Each post is by someone the demo account follows (or itself), or was reposted by one of them.
  const cards = [...first.body.matchAll(/<article class="post" data-post="([^"]+)">\s*(<p class="reposted)?/g)];
  for (const [, id, reposted] of cards) assert.ok(followed.has(byId.get(id).user_id) || reposted, id);
  assert.deepEqual(ids, (await store.feed(demoId(), { limit: PAGE_SIZE })).posts.map((p) => p.id), "same order as the store's feed");
  const next = first.body.match(/href="(\/\?cursor=[^"]+)" data-next/)[1];
  const second = await c.request(`${next}&fragment=1`);
  assert.doesNotMatch(second.body, /<html/, "the next page comes as a fragment for infinite scroll");
  const more = postIds(second.body);
  assert.equal(more.length, PAGE_SIZE);
  assert.equal(new Set([...ids, ...more]).size, PAGE_SIZE * 2);
  assert.match(first.body, /class="tray"/);
  assert.match(first.body, /Suggested for you/);
  const forYou = await c.request("/?tab=foryou");
  assert.equal(postIds(forYou.body).length, PAGE_SIZE);
  assert.ok(postIds(forYou.body).every((id) => byId.get(id).user_id !== demoId()));
});

test("the end of the feed says you're all caught up", async () => {
  const c = client();
  await c.request("/signup", { method: "POST", body: { name: "", username: "fewfollows", password: "longenough" } });
  // Follow the person with the fewest posts, so everything fits on one page.
  const perUser = data.users.slice(1).map((u) => [u.username, data.posts.filter((p) => p.user_id === u.id).length]).filter(([, n]) => n > 0);
  const [quiet, n] = perUser.sort((a, b) => a[1] - b[1])[0];
  assert.ok(n < PAGE_SIZE);
  await c.request(`/${quiet}/follow`, { method: "POST" });
  const home = await c.request("/");
  assert.match(home.body, /You're all caught up/);
  assert.doesNotMatch(home.body, /data-next/);
});

// ---- Likes, saves, comments --------------------------------------------------------------------------------

test("likes: JSON for the page script, a redirect back for plain forms, never counted twice", async () => {
  const c = client();
  await c.login();
  const post = data.posts.find((p) => p.user_id !== demoId() && !data.likes.some((l) => l.post_id === p.id && l.user_id === demoId()));
  const before = data.likes.filter((l) => l.post_id === post.id).length;
  const liked = (await c.request(`/p/${post.id}/like`, { method: "POST", json: true })).json();
  assert.deepEqual(liked, { liked: true, like_count: before + 1 });
  assert.equal((await c.request(`/p/${post.id}/like`, { method: "POST", json: true })).json().like_count, before + 1);
  const page = await c.request(`/p/${post.id}`);
  assert.match(page.body, /class="act like on" data-like aria-pressed="true"/);
  assert.deepEqual((await c.request(`/p/${post.id}/like`, { method: "DELETE", json: true })).json(), { liked: false, like_count: before });
  const form = await c.request(`/p/${post.id}/like`, { method: "POST", headers: { Referer: `${base}/explore` } });
  assert.deepEqual([form.status, form.location], [303, "/explore"]);
  const viaForm = await c.request(`/p/${post.id}/like?_method=DELETE`, { method: "POST" });
  assert.equal(viaForm.status, 303);
  assert.equal((await store.getPost(post.id, demoId())).liked, false);
});

test("saves show up on your Saved tab, which only you can see", async () => {
  const c = client();
  await c.login();
  const post = data.posts.find((p) => !data.saves.some((s) => s.post_id === p.id));
  assert.deepEqual((await c.request(`/p/${post.id}/save`, { method: "POST", json: true })).json(), { saved: true });
  const saved = await c.request(`/${DEMO.username}/saved`);
  assert.equal(saved.status, 200);
  assert.ok(saved.body.indexOf(post.id) > 0);
  const other = client();
  await other.login();
  const stranger = client();
  const sneak = await stranger.request(`/${DEMO.username}/saved`);
  assert.deepEqual([sneak.status, sneak.location], [302, `/${DEMO.username}`]);
  await c.request(`/p/${post.id}/save`, { method: "DELETE", json: true });
  assert.equal((await c.request(`/${DEMO.username}/saved`)).body.indexOf(post.id), -1);
});

test("comments: add (escaped, with links), delete your own; post owners can delete any comment on their post", async () => {
  const me = client();
  await me.login();
  const theirPost = data.posts.find((p) => p.user_id !== demoId());
  const added = await me.request(`/p/${theirPost.id}/comments`, { method: "POST", json: true, body: { body: "Love it <b>!</b> #sunset @demo" } });
  const { html, comment_count } = added.json();
  assert.match(html, /Love it &lt;b&gt;!&lt;\/b&gt;/);
  assert.match(html, /<a href="\/explore\/tags\/sunset" class="tag">#sunset<\/a>/);
  assert.match(html, /<a href="\/demo" class="tag">@demo<\/a>/);
  assert.equal(comment_count, data.comments.filter((c) => c.post_id === theirPost.id).length + 1);
  const id = html.match(/data-comment="([^"]+)"/)[1];
  assert.equal((await me.request(`/p/${theirPost.id}/comments`, { method: "POST", json: true, body: { body: "   " } })).status, 400);

  const owner = client();
  await owner.request("/signup", { method: "POST", body: { name: "", username: "owner1", password: "longenough" } });
  const someoneElse = (await me.request(`/comments/${id}`, { method: "DELETE", json: true })).json();
  assert.equal(someoneElse.deleted, true);

  // Someone else's comment on someone else's post: refused.
  const otherComment = data.comments.find((c) => c.user_id !== demoId() && data.posts.find((p) => p.id === c.post_id).user_id !== demoId());
  assert.equal((await me.request(`/comments/${otherComment.id}`, { method: "DELETE", json: true })).status, 403);
  // A comment on my own post by someone else: allowed.
  const onMine = data.comments.find((c) => data.posts.find((p) => p.id === c.post_id).user_id === demoId());
  assert.equal((await me.request(`/comments/${onMine.id}`, { method: "DELETE", json: true })).json().deleted, true);
});

// ---- Creating, editing and deleting posts -----------------------------------------------------------------------

test("create a post: the photo is checked, stored, and the post opens with its filter and shape", async () => {
  const c = client();
  await c.login();
  const form = new FormData();
  form.append("caption", "Sunrise at the lake #goldenhour");
  form.append("alt", "A lake at sunrise");
  form.append("filter", "clarendon");
  form.append("aspect", "portrait");
  form.append("media", png("evil.html"));
  const res = await c.request("/p", { method: "POST", body: form });
  assert.equal(res.status, 303);
  const id = res.location.split("/").pop();
  const post = await store.getPost(id, demoId());
  assert.deepEqual([post.caption, post.alt, post.filter, post.aspect], ["Sunrise at the lake #goldenhour", "A lake at sunrise", "clarendon", "portrait"]);
  assert.match(post.image, /^https:\/\/i\.imgur\.test\/[0-9a-f-]{36}\.png$/, "the file gets our name and an image extension, never .html");
  const page = await c.request(res.location);
  assert.match(page.body, /class="f-clarendon"/);
  assert.match(page.body, /alt="A lake at sunrise"/);
  assert.match(page.body, /Your post has been shared/);
  assert.equal(postIds((await c.request("/")).body)[0], id, "it tops your feed");
  assert.match((await c.request("/explore/tags/goldenhour")).body, new RegExp(id));
});

test("create refuses files that aren't photos, and missing photos", async () => {
  const c = client();
  await c.login();
  const fake = new FormData();
  fake.append("caption", "nope");
  fake.append("media", new File(["<script>alert(1)</script>"], "x.png", { type: "image/png" }));
  const res = await c.request("/p", { method: "POST", body: fake });
  assert.equal(res.status, 400);
  assert.match(res.body, /isn&#39;t a photo/);
  assert.match(res.body, /nope/, "the caption is kept in the form");
  const none = new FormData();
  none.append("caption", "no photo");
  assert.match((await c.request("/p", { method: "POST", body: none })).body, /Choose a photo/);
  const files = await readdir(uploadDir);
  assert.ok(files.every((f) => f.endsWith(".png")), "rejected uploads are deleted");
});

test("edit and delete: only the person who shared a post can change it", async () => {
  const me = client();
  await me.login();
  const mine = data.posts.find((p) => p.user_id === demoId());
  const edit = await me.request(`/p/${mine.id}?_method=PATCH`, { method: "POST", body: { caption: "New caption", alt: "", filter: "moon", aspect: "landscape" } });
  assert.deepEqual([edit.status, edit.location], [303, `/p/${mine.id}`]);
  const changed = await store.getPost(mine.id, demoId());
  assert.deepEqual([changed.caption, changed.filter, changed.aspect], ["New caption", "moon", "landscape"]);
  await me.request(`/p/${mine.id}?_method=PATCH`, { method: "POST", body: { filter: "<script>", aspect: "huge" } });
  assert.equal((await store.getPost(mine.id, demoId())).filter, "moon", "unknown filters are ignored");
  assert.equal((await me.request(`/p/${mine.id}/edit`)).status, 200);

  const theirs = data.posts.find((p) => p.user_id !== demoId());
  assert.equal((await me.request(`/p/${theirs.id}/edit`)).status, 403);
  assert.equal((await me.request(`/p/${theirs.id}?_method=PATCH`, { method: "POST", body: { caption: "hacked" } })).status, 403);
  assert.equal((await me.request(`/p/${theirs.id}?_method=DELETE`, { method: "POST" })).status, 403);
  assert.notEqual((await store.getPost(theirs.id, "")).caption, "hacked");

  const del = await me.request(`/p/${mine.id}?_method=DELETE`, { method: "POST" });
  assert.deepEqual([del.status, del.location], [303, `/${DEMO.username}`]);
  assert.equal((await me.request(`/p/${mine.id}`)).status, 404);
});

// ---- Following, profiles, stories ----------------------------------------------------------------------------------

test("follow and unfollow update the follower count and the feed", async () => {
  const c = client();
  await c.request("/signup", { method: "POST", body: { name: "", username: "follower1", password: "longenough" } });
  const target = data.users[3];
  const before = (await store.profileCounts(target.id)).followers;
  assert.deepEqual((await c.request(`/${target.username}/follow`, { method: "POST", json: true })).json(), { following: true, followers: before + 1 });
  const feed = postIds((await c.request("/")).body);
  assert.ok(feed.length > 0);
  const profile = await c.request(`/${target.username}`);
  assert.match(profile.body, /aria-pressed="true">Following</);
  assert.deepEqual((await c.request(`/${target.username}/follow`, { method: "DELETE", json: true })).json(), { following: false, followers: before });
  assert.equal((await c.request("/follower1/follow", { method: "POST", json: true })).status, 400, "you can't follow yourself");
});

test("profiles show counts, bio, mutual followers and the post grid; unknown names are 404", async () => {
  const c = client();
  await c.login();
  const user = data.users[2];
  const page = await c.request(`/${user.username}`);
  assert.equal(page.status, 200);
  const counts = await store.profileCounts(user.id);
  assert.match(page.body, new RegExp(`<span class="strong">${counts.posts}</span> posts?`));
  assert.equal((page.body.match(/class="tile"/g) || []).length, Math.min(24, counts.posts));
  assert.equal((await c.request("/no_such_person")).status, 404);
  assert.equal((await c.request("/Bad Name")).status, 404);
  const followers = await c.request(`/${user.username}/followers`);
  assert.equal(followers.status, 200);
  assert.equal((followers.body.match(/class="person"/g) || []).length, counts.followers);
});

test("stories: share one, watch others', and the ring turns grey once seen", async () => {
  const c = client();
  await c.login();
  const form = new FormData();
  form.append("kind", "story");
  form.append("media", png());
  const res = await c.request("/p", { method: "POST", body: form });
  assert.deepEqual([res.status, res.location], [303, "/"]);
  const home = (await c.request("/")).body;
  assert.match(home, /href="\/stories\/demo"/);
  const first = home.match(/href="\/stories\/(?!demo")([^"]+)"/)[1];
  const viewer = await c.request(`/stories/${first}`);
  assert.equal(viewer.status, 200);
  const storyIds = [...viewer.body.matchAll(/class="slide[^"]*" src="[^"]+" alt="[^"]*" data-id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(storyIds.length >= 1);
  assert.match(viewer.body, /data-next-user="\/stories\/[^"]+"/, "the player moves on to the next account");
  for (const id of storyIds) assert.equal((await c.request(`/stories/${id}/seen`, { method: "POST" })).status, 204);
  const after = (await c.request("/")).body;
  assert.match(after, new RegExp(`<span class="ring seen"><img class="avatar" src="[^"]+" width="56" height="56" alt=""></span>\\s*<span class="tray-name">${first.replace(".", "\\.")}</span>`));
  assert.equal((await c.request("/stories/nobody_here")).status, 404);
});

// ---- Explore, hashtags, search, notifications, settings ---------------------------------------------------------------

test("explore, hashtags and search", async () => {
  const c = client();
  await c.login();
  const explore = await c.request("/explore");
  assert.equal((explore.body.match(/class="tile"/g) || []).length, 24);
  assert.match(explore.body, /href="\/explore\?page=2" data-next/);
  const tag = await c.request("/explore/tags/travel");
  assert.equal(tag.status, 200);
  assert.match(tag.body, /#travel/);
  assert.equal((await c.request("/explore/tags/nonexistenttag")).status, 404);
  const search = await c.request(`/search?q=${DEMO.username}&fragment=1`);
  assert.match(search.body, /href="\/demo"/);
  const hash = await c.request("/search?q=%23sunset&fragment=1");
  assert.match(hash.body, /href="\/explore\/tags\/sunset"/);
  assert.match((await c.request("/search?q=zzzzzz")).body, /No results found/);
});

test("notifications group likes, comments and new followers by time", async () => {
  const c = client();
  await c.login();
  const page = await c.request("/activity");
  assert.equal(page.status, 200);
  assert.match(page.body, /<h2>Today<\/h2>/);
  assert.match(page.body, /started following you\./);
  assert.match(page.body, /liked your post\./);
});

test("settings: name, bio (150 characters at most) and appearance", async () => {
  const c = client();
  await c.request("/signup", { method: "POST", body: { name: "", username: "settings1", password: "longenough" } });
  const ok = await c.request("/accounts/edit", { method: "POST", body: { name: "Set Tings", bio: "Hello 👋 #hi" } });
  assert.deepEqual([ok.status, ok.location], [303, "/settings1"]);
  const profile = await c.request("/settings1");
  assert.match(profile.body, /Set Tings/);
  assert.match(profile.body, /Hello 👋 <a href="\/explore\/tags\/hi" class="tag">#hi<\/a>/);
  const long = await c.request("/accounts/edit", { method: "POST", body: { name: "x", bio: "😀".repeat(151) } });
  assert.equal(long.status, 400);
  assert.ok((await c.request("/accounts/edit", { method: "POST", body: { name: "x", bio: "😀".repeat(150) } })).status === 303, "an emoji counts as one character");
  await c.request("/appearance", { method: "POST", body: { theme: "dark" } });
  assert.match((await c.request("/settings1")).body, /<html lang="en" data-theme="dark">/);
});

// ---- Security --------------------------------------------------------------------------------------------------------------

test("text from users is escaped everywhere (no HTML injection)", async () => {
  const c = client();
  await c.request("/signup", { method: "POST", body: { name: "<img src=x onerror=alert(1)>", username: "xss_test", password: "longenough" } });
  await c.request("/accounts/edit", { method: "POST", body: { name: "<script>alert(1)</script>", bio: "\"><svg onload=alert(1)>" } });
  const form = new FormData();
  form.append("caption", "<script>alert(2)</script> #ok");
  form.append("media", png());
  const res = await c.request("/p", { method: "POST", body: form });
  for (const url of ["/xss_test", res.location, "/search?q=xss"]) {
    const { body } = await c.request(url);
    assert.ok(!body.includes("<script>alert"), url);
    assert.ok(!body.includes("<svg onload"), url);
  }
});

test("every page sends a strict Content-Security-Policy and other protective headers", async () => {
  const { headers, status } = await client().request("/login");
  assert.equal(status, 200);
  assert.match(headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(headers.get("x-powered-by"), null);

  // Security headers are also present on error responses (e.g. 404)
  const errRes = await client().request("/non-existent-page-for-header-check");
  assert.equal(errRes.status, 404);
  assert.match(errRes.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(errRes.headers.get("x-content-type-options"), "nosniff");
  assert.equal(errRes.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(errRes.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(errRes.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");

  const cookie = await (async () => {
    const res = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams(DEMO), redirect: "manual" });
    return res.headers.getSetCookie().find((c) => c.startsWith("sid="));
  })();
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test("requests from other websites are refused (CSRF)", async () => {
  const c = client();
  await c.login();
  const post = data.posts[10];

  // Foreign Origin is rejected
  const resEvilOrigin = await c.request(`/p/${post.id}/like`, { method: "POST", headers: { Origin: "https://evil.example" } });
  assert.equal(resEvilOrigin.status, 403);

  // Foreign Referer is rejected
  const resEvilReferer = await c.request(`/p/${post.id}/like`, { method: "POST", headers: { Referer: "https://evil.example/malicious-page" } });
  assert.equal(resEvilReferer.status, 403);

  // Same Origin is accepted
  const same = await c.request(`/p/${post.id}/like`, { method: "POST", json: true, headers: { Origin: base } });
  assert.equal(same.status, 200);

  // Requests without Origin/Referer (e.g. standard same-site form posts) are accepted
  const unlike = await c.request(`/p/${post.id}/like`, { method: "POST", json: true, body: { _method: "DELETE" } });
  assert.equal(unlike.status, 200);
});

test("old addresses from the first version redirect", async () => {
  const c = client();
  const id = data.posts[0].id;
  assert.deepEqual([(await c.request("/posts")).status, (await c.request("/posts")).location], [301, "/"]);
  assert.equal((await c.request(`/posts/${id}`)).location, `/p/${id}`);
  assert.equal((await c.request("/posts/new")).location, "/create");
});

test("filters and album art are served as CSS, one class each", async () => {
  const res = await fetch(`${base}/catalog.css`);
  assert.match(res.headers.get("content-type"), /text\/css/);
  const css = await res.text();
  for (const f of text.FILTERS) assert.ok(css.includes(`.f-${f.id}{filter:`), f.id);
  for (const t of TRACKS) assert.ok(css.includes(`.cover-${t.id}{background:linear-gradient(`), t.id);
});

// ---- Reels, music, reposts, messages -------------------------------------------------------------------------------

test("reels: a video becomes a reel with its poster, plays on the Reels page and the profile's Reels tab", async () => {
  const c = await newAccount("reelmaker");
  const form = new FormData();
  form.append("kind", "post"); // any video is a reel, even when shared as a post
  form.append("caption", "First reel #test");
  form.append("music", "sunrise-run");
  form.append("media", mp4("trip.mov.html"));
  form.append("poster", jpeg());
  const res = await c.request("/p", { method: "POST", body: form });
  assert.equal(res.status, 303);
  const id = res.location.split("/").pop();
  const reel = await store.getPost(id, "");
  assert.deepEqual([reel.kind, reel.aspect, reel.music], ["reel", "vertical", "sunrise-run"]);
  assert.match(reel.video, /^\/uploads\/[0-9a-f-]{36}\.mp4$/, "videos stay on this server, with our own name and extension");
  assert.match(reel.image, /^https:\/\/i\.imgur\.test\/[0-9a-f-]{36}\.jpg$/, "the poster is stored like a photo");
  const page = await c.request(res.location);
  assert.match(page.body, /<video src="\/uploads\/[^"]+\.mp4" poster="[^"]+"/);
  assert.match(page.body, /Your reel has been shared/);
  assert.match((await c.request("/reelmaker/reels")).body, new RegExp(id));
  const viewer = client();
  await viewer.login();
  const reels = await viewer.request(`/reels?start=${id}`);
  assert.equal(reels.status, 200);
  assert.equal(reels.body.match(/<section class="reel" data-post="([^"]+)"/)[1], id, "?start= opens that reel first");
  assert.equal((await viewer.request("/reels?page=2&fragment=1")).body.includes("<html"), false);
  const file = reel.video.split("/").pop();
  assert.ok((await readdir(uploadDir)).includes(file));
  await c.request(`/p/${id}?_method=DELETE`, { method: "POST" });
  assert.ok(!(await readdir(uploadDir)).includes(file), "deleting a reel deletes its video");
});

test("reels: photos can't be reels, stories can't be videos, and fake videos are refused", async () => {
  const c = await newAccount("strict");
  const photoReel = new FormData();
  photoReel.append("kind", "reel");
  photoReel.append("media", png());
  assert.match((await c.request("/p", { method: "POST", body: photoReel })).body, /Reels are videos/);
  const videoStory = new FormData();
  videoStory.append("kind", "story");
  videoStory.append("media", mp4());
  assert.match((await c.request("/p", { method: "POST", body: videoStory })).body, /isn&#39;t a photo/);
  const fake = new FormData();
  fake.append("media", new File(["<html><script>alert(1)</script>"], "x.mp4", { type: "video/mp4" }));
  assert.match((await c.request("/p", { method: "POST", body: fake })).body, /isn&#39;t a photo or a video/);
  assert.equal((await store.userPosts((await store.userByUsername("strict")).id, "", { limit: 5 })).length, 0);
});

test("plays are counted for reels", async () => {
  const reel = data.posts.find((p) => p.kind === "reel");
  const before = (await store.getPost(reel.id, "")).views;
  assert.equal((await fetch(`${base}/p/${reel.id}/view`, { method: "POST" })).status, 204);
  assert.equal((await store.getPost(reel.id, "")).views, before + 1);
});

test("music: add a track to a post, see it on the post, and on the track's page; unknown tracks are ignored", async () => {
  const c = await newAccount("musicfan");
  const form = new FormData();
  form.append("caption", "With a soundtrack");
  form.append("music", "coffee-and-rain");
  form.append("media", png());
  const res = await c.request("/p", { method: "POST", body: form });
  const id = res.location.split("/").pop();
  assert.equal((await store.getPost(id, "")).music, "coffee-and-rain");
  const page = await c.request(res.location);
  assert.match(page.body, /href="\/audio\/coffee-and-rain" class="music-line"/);
  assert.match(page.body, /data-music="\/media\/music\/coffee-and-rain\.mp3"/);
  const audio = await c.request("/audio/coffee-and-rain");
  assert.equal(audio.status, 200);
  assert.match(audio.body, /Lo-Fi Lantern/);
  assert.ok(audio.body.includes(id));
  assert.equal((await c.request("/audio/not-a-track")).status, 404);
  assert.equal((await fetch(`${base}/media/music/coffee-and-rain.mp3`)).headers.get("content-type"), "audio/mpeg");
  await c.request(`/p/${id}?_method=PATCH`, { method: "POST", body: { music: "<script>" } });
  assert.equal((await store.getPost(id, "")).music, "", "an unknown track means no music");
  assert.match((await c.request("/create?music=stardust")).body, /value="stardust" checked/, "“Use audio” preselects the track");
});

test("stories can have music", async () => {
  const c = await newAccount("storysong");
  const form = new FormData();
  form.append("kind", "story");
  form.append("music", "paper-boats");
  form.append("media", png());
  await c.request("/p", { method: "POST", body: form });
  const player = await c.request("/stories/storysong");
  assert.match(player.body, /data-music="\/media\/music\/paper-boats\.mp3" data-music-title="Paper Boats · The Quiet Rooms"/);
});

test("reposts: show in followers' feeds and on the Reposts tab, notify the author; your own posts can't be reposted", async () => {
  const author = await newAccount("original");
  const form = new FormData();
  form.append("caption", "Repost me");
  form.append("media", png());
  const id = (await author.request("/p", { method: "POST", body: form })).location.split("/").pop();
  assert.equal((await author.request(`/p/${id}/repost`, { method: "POST", json: true })).status, 400);

  const fan = await newAccount("reposter");
  const follower = await newAccount("watcher");
  await follower.request("/reposter/follow", { method: "POST" });
  assert.deepEqual((await fan.request(`/p/${id}/repost`, { method: "POST", json: true })).json(), { reposted: true, repost_count: 1 });
  assert.deepEqual((await fan.request(`/p/${id}/repost`, { method: "POST", json: true })).json(), { reposted: true, repost_count: 1 });
  const feed = await follower.request("/");
  assert.match(feed.body, new RegExp(`<article class="post" data-post="${id}">\\s*<p class="reposted muted">.*?<a href="/reposter" class="username">reposter</a> reposted`, "s"));
  assert.ok((await follower.request("/reposter/reposts")).body.includes(id));
  assert.match((await author.request("/activity")).body, /reposter<\/a>\s*reposted your post\./);
  assert.deepEqual((await fan.request(`/p/${id}/repost`, { method: "DELETE", json: true })).json(), { reposted: false, repost_count: 0 });
  assert.ok(!(await follower.request("/")).body.includes(id));
});

test("messages: send, see them in the inbox with an unread badge, read them, and see “Seen”", async () => {
  const ana = await newAccount("dm_ana");
  const ben = await newAccount("dm_ben");
  const sent = await ana.request("/direct/t/dm_ben", { method: "POST", json: true, body: { body: "hi <b>ben</b> #hello" } });
  assert.equal(sent.status, 200);
  assert.match(sent.json().html, /class="msg mine"/);
  assert.match(sent.json().html, /hi &lt;b&gt;ben&lt;\/b&gt; <a href="\/explore\/tags\/hello" class="tag">#hello<\/a>/);
  const inbox = await ben.request("/direct/inbox");
  assert.match(inbox.body, /class="chat unread" href="\/direct\/t\/dm_ana"/);
  assert.match(inbox.body, /<span class="badge" data-unread-badge>1<\/span>/, "the Messages icon shows 1 unread chat");
  const thread = await ben.request("/direct/t/dm_ana");
  assert.match(thread.body, /class="msg" data-message/);
  assert.doesNotMatch(thread.body, /<span class="badge" data-unread-badge>1<\/span>/, "opening the chat reads it");
  assert.match((await ana.request("/direct/t/dm_ben")).body, /<p class="seen muted" data-seen>Seen<\/p>/);
  assert.equal((await ana.request("/direct/t/dm_ben", { method: "POST", json: true, body: { body: "  " } })).status, 400);
  assert.equal((await ana.request("/direct/t/dm_ana")).status, 404, "no chats with yourself");
  assert.equal((await ana.request("/direct/t/nobody_at_all", { method: "POST", json: true, body: { body: "x" } })).status, 404);
  const form = await ana.request("/direct/t/dm_ben", { method: "POST", body: { body: "plain form" } });
  assert.deepEqual([form.status, form.location], [303, "/direct/t/dm_ben"]);
  assert.equal((await client().request("/direct/inbox")).status, 303, "logged-out people go to the login page");
});

test("messages arrive live, and so does “Seen” (Server-Sent Events)", async () => {
  const ana = await newAccount("live_ana");
  const ben = await newAccount("live_ben");
  const benStream = await events(ben);
  const anaStream = await events(ana);
  assert.match(benStream.headers.get("content-type"), /text\/event-stream/);
  await ana.request("/direct/t/live_ben", { method: "POST", json: true, body: { body: "are you there?" } });
  const message = await benStream.next("message");
  assert.equal(message.from, "live_ana");
  assert.equal(message.unread, 1);
  assert.match(message.html, /class="msg" data-message/);
  assert.match(message.html, /are you there\?/);
  await ben.request("/direct/t/live_ana/read", { method: "POST", json: true });
  assert.deepEqual(await anaStream.next("read"), { by: "live_ben" });
  benStream.close();
  anaStream.close();
});

test("share a post to a chat from the share sheet", async () => {
  const ana = await newAccount("share_ana");
  const ben = await newAccount("share_ben");
  await ana.request("/share_ben/follow", { method: "POST" });
  const post = data.posts.findLast((p) => p.kind === "photo");
  const sheet = await ana.request(`/p/${post.id}/share?fragment=1`);
  assert.match(sheet.body, /<input type="hidden" name="to" value="share_ben">/, "people you follow are listed");
  assert.deepEqual((await ana.request(`/p/${post.id}/share`, { method: "POST", json: true, body: { to: "share_ben" } })).json(), { sent: true, to: "share_ben" });
  const thread = await ben.request("/direct/t/share_ana");
  assert.match(thread.body, new RegExp(`class="msg-post" href="/p/${post.id}"`));
  assert.equal((await ana.request(`/p/${post.id}/share`, { method: "POST", json: true, body: { to: "share_ana" } })).status, 404, "not to yourself");
  assert.match((await ana.request(`/p/${post.id}/share`)).body, /Copy link/, "works as a page without JavaScript");
});

// ---- Units ------------------------------------------------------------------------------------------------------------------

test("passwords: scrypt hashes with a salt; accounts with the hash '!' can't log in", async () => {
  const h = await auth.hashPassword("hunter22");
  assert.match(h, /^scrypt\$[\w-]+\$[\w-]{86}$/);
  assert.notEqual(h, await auth.hashPassword("hunter22"));
  assert.equal(await auth.verifyPassword("hunter22", h), true);
  assert.equal(await auth.verifyPassword("hunter23", h), false);
  assert.equal(await auth.verifyPassword("", "!"), false);
  assert.equal(await auth.verifyPassword("x", "scrypt$abc$short"), false);
});

test("session tokens expire after 30 days and can't be forged", () => {
  const t = auth.sessionToken("user-1", "s", Date.UTC(2026, 0, 1));
  assert.equal(auth.readSession(t, "s", Date.UTC(2026, 0, 20)), "user-1");
  assert.equal(auth.readSession(t, "s", Date.UTC(2026, 1, 5)), null);
  assert.equal(auth.readSession(t, "other secret", Date.UTC(2026, 0, 2)), null);
  assert.equal(auth.readSession("garbage", "s"), null);
  assert.equal(auth.readSession(undefined, "s"), null);
});

test("captions: hashtags and mentions become links, everything else is escaped", () => {
  assert.equal(text.rich("Hi <b> & #Sunset @Ana.B!"), 'Hi &lt;b&gt; &amp; <a href="/explore/tags/sunset" class="tag">#Sunset</a> <a href="/ana.b" class="tag">@Ana.B</a>!');
  assert.equal(text.rich("mail me@site.com"), "mail me@site.com", "an email address is not a mention");
  assert.equal(text.rich("#café #日本"), '<a href="/explore/tags/caf%C3%A9" class="tag">#café</a> <a href="/explore/tags/%E6%97%A5%E6%9C%AC" class="tag">#日本</a>');
  assert.equal(text.rich("it's #fun"), 'it&#39;s <a href="/explore/tags/fun" class="tag">#fun</a>', "the escaper's own &#39; never becomes a hashtag");
  assert.deepEqual(text.hashtags("a #One b #two #two"), ["one", "two", "two"]);
});

test("times, counts and usernames", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const ago = (ms) => new Date(+now - ms);
  assert.equal(text.ago(ago(30_000), now), "now");
  assert.equal(text.ago(ago(5 * 60_000), now), "5m");
  assert.equal(text.ago(ago(3 * 3_600_000), now), "3h");
  assert.equal(text.ago(ago(2 * 86_400_000), now), "2d");
  assert.equal(text.ago(ago(15 * 86_400_000), now), "2w");
  assert.equal(text.agoLong(ago(3_600_000), now), "1 hour ago");
  assert.equal(text.agoLong(ago(2 * 86_400_000), now), "2 days ago");
  assert.equal(text.compact(1234), "1,234");
  assert.equal(text.compact(12_560), "12.5K");
  assert.equal(text.compact(3_450_000), "3.4M");
  for (const ok of ["a", "ana.b", "x_9", "a".repeat(30)]) assert.match(ok, text.USERNAME);
  for (const bad of [".a", "a.", "a..b", "A", "a b", "a".repeat(31), ""]) assert.doesNotMatch(bad, text.USERNAME);
});

test("MySQL queries only use placeholders: input never becomes SQL", async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^DELETE/.test(sql)) return [{ affectedRows: 0 }];
      return [[{ n: 0, posts: 0, followers: 0, following: 0 }], {}];
    },
  };
  const s = mysqlStore(pool);
  const evil = `"); DROP TABLE users; --`;
  await s.createPost({ id: evil, userId: evil, image: evil, caption: evil, alt: evil, filter: evil, aspect: evil });
  await s.getPost(evil, evil);
  await s.updatePost(evil, { caption: evil, image: "x", user_id: "ignored" });
  await s.searchUsers(evil);
  await s.addComment({ id: evil, postId: evil, userId: evil, body: evil });
  await s.feed(evil, { limit: 5, before: { t: new Date(), id: evil } });
  await s.removePost(evil);
  for (const c of calls) assert.ok(!c.sql.includes("DROP TABLE"), c.sql);
  assert.ok(calls.every((c) => JSON.stringify(c.params).includes("DROP TABLE")));
  assert.match(calls[2].sql, /^UPDATE posts SET caption = \?, image = \? WHERE id = \?$/, "only known columns can change");
});

test("images go to Imgur with the Client-ID from .env, else stay on this server", async () => {
  assert.equal(await imageStore({ clientId: "" })({ filename: "a.png" }), "/uploads/a.png");
  const file = path.join(uploadDir, "b.png");
  await (await import("node:fs/promises")).writeFile(file, Uint8Array.of(1, 2, 3));
  let sent;
  const fakeImgur = async (url, init) => {
    sent = { url, auth: init.headers.Authorization };
    return new Response(JSON.stringify({ success: true, data: { link: "https://i.imgur.com/abc.png" } }), { status: 200 });
  };
  assert.equal(await imageStore({ clientId: "my-client-id", fetchImpl: fakeImgur })({ filename: "b.png", path: file }), "https://i.imgur.com/abc.png");
  assert.deepEqual(sent, { url: "https://api.imgur.com/3/image", auth: "Client-ID my-client-id" });
});

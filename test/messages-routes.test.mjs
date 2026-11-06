import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createMessagesRouter } from "../routes/messages.routes.mjs";
import { createRealtimeBus } from "../lib/realtime.mjs";
import { needLogin } from "../middleware/auth.mjs";

test("Inbox, new thread, and conversation validation", async () => {
  const mockStore = {
    async inbox(id) {
      return [{ id: "chat-1", other: { username: "bob" } }];
    },
    async userByUsername(username) {
      if (username === "bob") return { id: "user-bob", username: "bob", name: "Bob" };
      return null;
    },
    async thread() {
      return [];
    },
    async markRead() {
      return false;
    },
  };

  const app = express();
  app.set("view engine", "ejs");
  app.engine("ejs", (p, d, cb) => cb(null, "view-stub"));

  app.use((req, res, next) => {
    req.me = { id: "user-alice", username: "alice" };
    next();
  });

  const bus = createRealtimeBus();
  app.use(createMessagesRouter({ store: mockStore, needLogin, bus }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  // 1. GET /direct redirects to /direct/inbox
  const resRedirect = await fetch(`http://127.0.0.1:${port}/direct`, { redirect: "manual" });
  assert.equal(resRedirect.status, 302);
  assert.equal(resRedirect.headers.get("location"), "/direct/inbox");

  // 2. GET /direct/inbox renders 200
  const resInbox = await fetch(`http://127.0.0.1:${port}/direct/inbox`);
  assert.equal(resInbox.status, 200);

  // 3. GET /direct/t/:username with valid user renders 200
  const resThread = await fetch(`http://127.0.0.1:${port}/direct/t/bob`);
  assert.equal(resThread.status, 200);

  // 4. GET /direct/t/:username with non-existent user returns 404
  const res404 = await fetch(`http://127.0.0.1:${port}/direct/t/unknown_user`);
  assert.equal(res404.status, 404);

  // 5. GET /direct/t/:username with self returns 404
  const resSelf = await fetch(`http://127.0.0.1:${port}/direct/t/alice`);
  assert.equal(resSelf.status, 404);

  await new Promise((ok) => server.close(ok));
});

test("Sending messages, body validation, and post sharing", async () => {
  let sentMessage = null;
  const mockStore = {
    async userByUsername(username) {
      if (username === "charlie") return { id: "user-charlie", username: "charlie" };
      return null;
    },
    async sendMessage(msg) {
      sentMessage = msg;
    },
    async getPost(id) {
      if (id === "11111111-1111-1111-1111-111111111111") {
        return {
          id,
          kind: "photo",
          image: "/uploads/img.jpg",
          filter: "normal",
          caption: "Awesome post",
          user: { username: "author", avatar: "/avatar.jpg" },
        };
      }
      return null;
    },
  };

  const bus = createRealtimeBus();
  let receivedEvent = null;
  bus.subscribe("user-charlie", (e) => {
    receivedEvent = e;
  });

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((req, res, next) => {
    req.me = { id: "user-alice", username: "alice" };
    next();
  });
  app.use(createMessagesRouter({
    store: mockStore,
    needLogin,
    bus,
    renderToString: async () => "<div class='msg'>hello</div>",
  }));

  const server = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const port = server.address().port;

  // Empty message returns 400
  const resEmpty = await fetch(`http://127.0.0.1:${port}/direct/t/charlie`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ body: "   " }),
  });
  assert.equal(resEmpty.status, 400);

  // Valid message sends and notifies bus
  const resSend = await fetch(`http://127.0.0.1:${port}/direct/t/charlie`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ body: "Hey Charlie!" }),
  });
  assert.equal(resSend.status, 200);
  const jsonSend = await resSend.json();
  assert.equal(jsonSend.html, "<div class='msg'>hello</div>");
  assert.equal(sentMessage.recipientId, "user-charlie");
  assert.equal(sentMessage.body, "Hey Charlie!");
  assert.equal(receivedEvent?.type, "message");
  assert.equal(receivedEvent?.from.username, "alice");

  // Post sharing endpoint
  const resShare = await fetch(`http://127.0.0.1:${port}/p/11111111-1111-1111-1111-111111111111/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ to: "charlie", body: "Check this out!" }),
  });
  assert.equal(resShare.status, 200);
  assert.equal(sentMessage.postId, "11111111-1111-1111-1111-111111111111");

  await new Promise((ok) => server.close(ok));
});

test("SSE connection, headers, event delivery, isolation, multiple clients, and cleanup", async () => {
  const bus = createRealtimeBus();
  const mockStore = {
    async unreadThreads() {
      return 3;
    },
  };

  const app = express();
  let currentViewer = { id: "user-alice", username: "alice" };
  app.use((req, res, next) => {
    req.me = currentViewer;
    next();
  });
  app.use(createMessagesRouter({
    store: mockStore,
    needLogin,
    bus,
    renderToString: async (v, locals) => `<div>from ${locals.other.username}</div>`,
  }));

  const server = http.createServer(app);
  await new Promise((ok) => server.listen(0, ok));
  const port = server.address().port;

  // Helper to open SSE connection using raw http.get
  const connectSSE = () =>
    new Promise((resolve) => {
      const chunks = [];
      const req = http.get(`http://127.0.0.1:${port}/direct/events`, (res) => {
        res.on("data", (chunk) => chunks.push(chunk.toString()));
        resolve({ req, res, chunks });
      });
    });

  // Client 1 (Alice) connects
  currentViewer = { id: "user-alice", username: "alice" };
  const client1 = await connectSSE();
  assert.ok(client1.res.headers["content-type"].includes("text/event-stream"));
  assert.equal(client1.res.headers["cache-control"], "no-store");
  assert.equal(bus.listenerCount("user-alice"), 1);

  // Client 2 (Alice reconnect/second tab) connects
  const client2 = await connectSSE();
  assert.equal(bus.listenerCount("user-alice"), 2);

  // Client 3 (Bob) connects
  currentViewer = { id: "user-bob", username: "bob" };
  const client3 = await connectSSE();
  assert.equal(bus.listenerCount("user-bob"), 1);

  // Wait a moment for initial handshake (retry: 4000)
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(client1.chunks.join("").includes("retry: 4000"));
  assert.ok(client3.chunks.join("").includes("retry: 4000"));

  // Emit event to Alice
  bus.emit("user-alice", {
    type: "message",
    from: { username: "charlie", name: "Charlie" },
    message: { id: "m1", body: "Hello Alice" },
  });

  // Emit read event to Alice
  bus.emit("user-alice", {
    type: "read",
    by: "charlie",
  });

  // Wait for delivery
  await new Promise((r) => setTimeout(r, 60));

  const alice1Output = client1.chunks.join("");
  const alice2Output = client2.chunks.join("");
  const bobOutput = client3.chunks.join("");

  // Both Alice connections received the message event and read event
  assert.ok(alice1Output.includes("event: message"));
  assert.ok(alice1Output.includes("charlie"));
  assert.ok(alice1Output.includes("event: read"));

  assert.ok(alice2Output.includes("event: message"));
  assert.ok(alice2Output.includes("event: read"));

  // Event Isolation: Bob must NEVER receive Alice's events!
  assert.ok(!bobOutput.includes("event: message"));
  assert.ok(!bobOutput.includes("event: read"));

  // Test Disconnect and Listener Cleanup
  client1.req.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bus.listenerCount("user-alice"), 1); // 1 connection remains for Alice

  client2.req.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bus.listenerCount("user-alice"), 0); // All Alice connections closed

  client3.req.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bus.listenerCount("user-bob"), 0); // Bob connection closed

  await new Promise((ok) => server.close(ok));
});

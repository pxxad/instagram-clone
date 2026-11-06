import { test } from "node:test";
import assert from "node:assert/strict";
import { createRealtimeBus } from "../lib/realtime.mjs";

test("realtime bus delivers events strictly to target user", async () => {
  const bus = createRealtimeBus();
  const user1Events = [];
  const user2Events = [];

  const unsub1 = bus.subscribe("user-1", (e) => user1Events.push(e));
  const unsub2 = bus.subscribe("user-2", (e) => user2Events.push(e));

  assert.equal(bus.listenerCount("user-1"), 1);
  assert.equal(bus.listenerCount("user-2"), 1);

  bus.emit("user-1", { type: "message", text: "hello user 1" });
  bus.emit("user-2", { type: "message", text: "hello user 2" });

  assert.equal(user1Events.length, 1);
  assert.equal(user1Events[0].text, "hello user 1");

  assert.equal(user2Events.length, 1);
  assert.equal(user2Events[0].text, "hello user 2");

  // Unsubscribe user 1
  unsub1();
  assert.equal(bus.listenerCount("user-1"), 0);

  // Calling unsub1 again is safely idempotent
  unsub1();
  assert.equal(bus.listenerCount("user-1"), 0);

  // Subsequent events to user 1 are not received
  bus.emit("user-1", { type: "message", text: "second message" });
  assert.equal(user1Events.length, 1);

  // User 2 still receives events
  bus.emit("user-2", { type: "message", text: "second message for user 2" });
  assert.equal(user2Events.length, 2);

  unsub2();
  assert.equal(bus.listenerCount("user-2"), 0);
});

test("realtime bus handles invalid IDs or listeners gracefully", () => {
  const bus = createRealtimeBus();
  assert.doesNotThrow(() => bus.emit(null, { type: "test" }));
  assert.doesNotThrow(() => bus.emit("", { type: "test" }));

  const unsubNull = bus.subscribe(null, () => {});
  assert.equal(typeof unsubNull, "function");
  unsubNull();

  const unsubNoFn = bus.subscribe("user-1", null);
  assert.equal(typeof unsubNoFn, "function");
  unsubNoFn();

  assert.equal(bus.listenerCount("user-1"), 0);
});

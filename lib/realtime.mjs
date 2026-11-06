// Realtime infrastructure: user-scoped event bus for live notifications and Server-Sent Events (SSE).
import { EventEmitter } from "node:events";

/**
 * Creates an event bus for real-time notifications (messages, read receipts).
 * Events are keyed by recipient user ID.
 */
export function createRealtimeBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  return {
    /**
     * Emits a user-scoped event (e.g. message, read receipt) to the recipient.
     * @param {string} userId - Recipient user ID
     * @param {object} event - Event payload { type, ... }
     */
    emit(userId, event) {
      if (!userId) return;
      emitter.emit(userId, event);
    },

    /**
     * Subscribes a listener to events for a specific user ID.
     * Returns an idempotent cleanup function.
     * @param {string} userId - Target user ID
     * @param {Function} listener - Callback function
     * @returns {Function} Unsubscribe function
     */
    subscribe(userId, listener) {
      if (!userId || typeof listener !== "function") return () => {};
      emitter.on(userId, listener);
      let removed = false;
      return () => {
        if (!removed) {
          removed = true;
          emitter.off(userId, listener);
        }
      };
    },

    /**
     * Explicitly unbinds a listener for a user ID.
     */
    unsubscribe(userId, listener) {
      if (!userId || typeof listener !== "function") return;
      emitter.off(userId, listener);
    },

    /**
     * Returns active listener count for a user ID.
     */
    listenerCount(userId) {
      return emitter.listenerCount(userId);
    },

    /**
     * Access to underlying EventEmitter if needed for backwards compatibility.
     */
    get emitter() {
      return emitter;
    },
  };
}

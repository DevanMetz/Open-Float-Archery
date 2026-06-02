// Minimal reactive primitives. This module is the whole "framework": a pub/sub
// event bus for transport/log/status messages, and a tiny observable state
// store the UI subscribes to. No dependencies, no build step.

export class EventBus {
  constructor() {
    this.handlers = new Map();
  }

  on(type, fn) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  emit(type, payload) {
    const set = this.handlers.get(type);
    if (set) {
      for (const fn of set) fn(payload);
    }
  }
}

export function createStore(initial) {
  let state = { ...initial };
  const subscribers = new Set();

  return {
    get: () => state,

    set(patch) {
      state = { ...state, ...patch };
      for (const fn of subscribers) fn(state);
    },

    subscribe(fn) {
      subscribers.add(fn);
      fn(state);
      return () => subscribers.delete(fn);
    },
  };
}

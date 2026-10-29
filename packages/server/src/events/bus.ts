import type { ServerEvent } from "@vibe-center/shared";

type Listener = (event: ServerEvent) => void;

/**
 * In-process fan-out of live-update events. Domain services publish; the WebSocket hub (and
 * anything else, e.g. the voice bridge or tests) subscribes. Listeners run synchronously in
 * publish order and must not throw.
 */
export class EventBus {
  private listeners = new Set<Listener>();

  publish(event: ServerEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error("event listener failed", e);
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

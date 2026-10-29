// The WebSocket event channel. One socket per device, all events go to all devices (single user).
// Each phase adds its events in its own file; consumers switch on `type` and must ignore types
// they don't know, so adding an event never breaks an older client.
import type { CoreEvent } from "./core.ts";
import type { McpEvent } from "./mcp.ts";
import type { VoiceEvent } from "./voice.ts";

export type { CoreEvent, McpEvent, VoiceEvent };

export type ServerEvent = CoreEvent | McpEvent | VoiceEvent;
export type ServerEventType = ServerEvent["type"];
export type EventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;

/** Client → server frames. Mutations go through HTTP; the socket only carries keep-alives. */
export type ClientFrame = { type: "ping" };

/** Server → client frame. `pong` answers `ping`. */
export type ServerFrame = ServerEvent | { type: "pong" };

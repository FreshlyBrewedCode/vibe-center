// HTTP API contract: paths, request schemas (validated by the server) and response types.
// Every /api route except POST /api/auth/exchange needs the device-session cookie.
import { z } from "zod";
import type {
  AgentView,
  Conversation,
  Device,
  Harness,
  Message,
  MessageSearchHit,
  Session,
} from "./domain.ts";

export const paths = {
  authExchange: "/api/auth/exchange",
  authMe: "/api/auth/me",
  authLogout: "/api/auth/logout",
  agents: "/api/agents",
  agent: (id: string) => `/api/agents/${id}`,
  conversation: (id: string) => `/api/conversations/${id}`,
  messages: (conversationId: string) => `/api/conversations/${conversationId}/messages`,
  cancel: (conversationId: string) => `/api/conversations/${conversationId}/cancel`,
  sessions: (conversationId: string) => `/api/conversations/${conversationId}/sessions`,
  read: (conversationId: string) => `/api/conversations/${conversationId}/read`,
  permission: (messageId: string) => `/api/messages/${messageId}/permission`,
  search: "/api/search",
  harnesses: "/api/harnesses",
  harness: (id: string) => `/api/harnesses/${id}`,
  harnessProbe: (id: string) => `/api/harnesses/${id}/probe`,
  devices: "/api/devices",
  device: (id: string) => `/api/devices/${id}`,
  info: "/api/info",
  ws: "/ws",
} as const;

// ---- request schemas --------------------------------------------------------------------------

export const AuthExchangeBody = z.object({
  token: z.string().min(16),
  deviceName: z.string().max(100).optional(),
});

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// Field schemas without defaults: the PATCH schemas are built from these, because `.partial()`
// of a field with `.default()` would fill the default in and overwrite the stored value.
const agentFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500),
  avatar: z.object({ emoji: z.string().min(1).max(16), color: hexColor }),
  systemPrompt: z.string().max(50_000),
  harnessId: z.string().min(1),
  model: z.string().min(1).nullable(),
  options: z.record(z.string(), z.union([z.string(), z.boolean()])),
  cwd: z
    .string()
    .min(1)
    .refine((p) => p.startsWith("/") || p.startsWith("~"), "must be an absolute path"),
  voice: z.string().nullable(),
};

export const AgentBody = z.object({
  ...agentFields,
  description: agentFields.description.default(""),
  systemPrompt: agentFields.systemPrompt.default(""),
  model: agentFields.model.default(null),
  options: agentFields.options.default({}),
  voice: agentFields.voice.default(null),
});
export type AgentBody = z.input<typeof AgentBody>;
/** AgentBody after validation (defaults applied). */
export type AgentInput = z.output<typeof AgentBody>;
export const AgentPatchBody = z.object(agentFields).partial();
export type AgentPatchBody = z.input<typeof AgentPatchBody>;

export const SendMessageBody = z.object({ text: z.string().trim().min(1).max(100_000) });
export const ReadBody = z.object({ seq: z.number().int().nonnegative() });
export const PermissionBody = z.object({ optionId: z.string().min(1) });

const harnessFields = {
  name: z.string().trim().min(1).max(80),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
};
export const HarnessBody = z.object({
  ...harnessFields,
  command: harnessFields.command.default(""),
  args: harnessFields.args.default([]),
  env: harnessFields.env.default({}),
});
export type HarnessBody = z.input<typeof HarnessBody>;
export type HarnessInput = z.output<typeof HarnessBody>;
export const HarnessPatchBody = z.object(harnessFields).partial();
export type HarnessPatchBody = z.input<typeof HarnessPatchBody>;

export const MessagesQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const SearchQuery = z.object({
  q: z.string().trim().min(1),
  agentId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// ---- responses --------------------------------------------------------------------------------

export interface ApiError {
  error: string;
  /** Points the UI at the setting that fixes it, e.g. "harness:claude-code". */
  hint?: string;
}

export interface MeResponse {
  device: Device;
}
export type AgentsResponse = AgentView[];
export type AgentResponse = AgentView;
export interface ConversationResponse {
  conversation: Conversation;
  sessions: Session[];
}
export interface MessagesResponse {
  messages: Message[];
  /** True if older messages exist before the first one returned. */
  hasMore: boolean;
}
export interface SendMessageResponse {
  message: Message;
  turnId: string;
}
export type HarnessesResponse = Harness[];
export type DevicesResponse = Device[];
export type SearchResponse = MessageSearchHit[];
/** Mostly-static info for the General settings page. */
export interface InfoResponse {
  version: string;
  dataDir: string;
  /** The tailnet HTTPS URL `tailscale serve` published, if any. */
  publicUrl: string | null;
}

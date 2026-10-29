// The one place the app picks its ACP SDK entrypoint. We use the v1 "unstable" surface because
// the spec's `systemPrompt` on session/new (which claude-agent-acp advertises) lives there.
// Import ACP types and helpers from here, never from the SDK directly.
export * from "@agentclientprotocol/sdk/unstable";

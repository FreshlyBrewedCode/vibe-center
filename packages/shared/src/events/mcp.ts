// Events owned by phase 2a (MCP gateway + built-in tools): e.g. MCP server status, tool
// invocations through the gateway, memory changes. Add members to this union; keep `never`
// until the first one exists.
export type McpEvent = never;

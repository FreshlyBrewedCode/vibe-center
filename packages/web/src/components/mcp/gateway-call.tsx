import type { GatewayCallInfo } from "@vibe-center/shared";

/** Title for a tool card the gateway served: `server · tool`, built-ins without the server. */
export function gatewayTitle(g: GatewayCallInfo): string {
  return g.server === "builtin" ? g.tool.replaceAll("_", " ") : `${g.server} · ${g.tool}`;
}

/** The gateway's own record of a tool call: arguments and result, shown inside the tool card. */
export function GatewayCallDetails({ call }: { call: GatewayCallInfo }) {
  return (
    <div data-testid="gateway-call" className="space-y-2">
      <p className="text-muted-foreground text-xs">
        via MCP gateway · {call.server === "builtin" ? "built-in" : call.server} ·{" "}
        <code className="font-mono">{call.tool}</code>
        {call.durationMs !== null && ` · ${call.durationMs} ms`}
      </p>
      <Block label="Arguments" value={call.args} />
      {call.result !== null && (
        <Block label={call.isError ? "Error" : "Result"} value={pretty(call.result)} />
      )}
    </div>
  );
}

function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function Block({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="space-y-1">
      <div className="vc-label">{label}</div>
      <pre className="vc-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-background px-3 py-2 font-mono text-xs leading-[1.5]">
        {text}
      </pre>
    </div>
  );
}

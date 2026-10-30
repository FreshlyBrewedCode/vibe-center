// Server state lives in TanStack Query. Query keys are defined here once; the live event
// channel (events.ts) patches the same cache entries, so components just read queries.

import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AgentBody,
  type AgentPatchBody,
  type AgentsResponse,
  type AgentToolsPatchBody,
  type AgentToolsResponse,
  type AgentView,
  type Call,
  type CallsResponse,
  type ConversationResponse,
  type DeviceResponse,
  type DevicesResponse,
  type GpuSpeechAction,
  type Harness,
  type HarnessBody,
  type HarnessesResponse,
  type HarnessPatchBody,
  type InfoResponse,
  type McpOAuthCallbackBody,
  type McpOAuthCallbackResponse,
  type McpOAuthStartBody,
  type McpOAuthStartResponse,
  type McpServerBody,
  type McpServerPatchBody,
  type McpServersResponse,
  type McpServerView,
  type MemoriesResponse,
  type Memory,
  type MemoryBody,
  type MemoryPatchBody,
  type MeResponse,
  type MessageSearchHit,
  type MessagesResponse,
  type MintLinkResponse,
  mcpPaths,
  paths,
  type RecordingsResponse,
  type SendMessageResponse,
  type SttModel,
  type SttModelAction,
  type SttModelsResponse,
  type VoiceSettings,
  type VoiceSettingsPatchBody,
  type VoiceStatus,
  type VoicesResponse,
  voicePaths,
} from "@vibe-center/shared";
import { ApiError, api } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Live events keep the cache fresh; refetch only on reconnect (see events.ts).
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

export const keys = {
  me: ["me"] as const,
  agents: ["agents"] as const,
  harnesses: ["harnesses"] as const,
  devices: ["devices"] as const,
  conversation: (id: string) => ["conversation", id] as const,
  messages: (conversationId: string) => ["messages", conversationId] as const,
  info: ["info"] as const,
  mcpServers: ["mcp-servers"] as const,
  agentTools: (agentId: string) => ["agent-tools", agentId] as const,
  /** `scope`: an agent id, "shared", or "" for all. */
  memories: (scope: string, q: string) => ["memories", scope, q] as const,
  voiceSettings: ["voice", "settings"] as const,
  voiceStatus: ["voice", "status"] as const,
  voices: ["voice", "voices"] as const,
  calls: ["voice", "calls"] as const,
  sttModels: ["voice", "stt-models"] as const,
  recordings: ["voice", "recordings"] as const,
};

/** The signed-in device, or null when signed out (401). */
export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return (await api.get<MeResponse>(paths.authMe)).device;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
}

export const useAgents = () =>
  useQuery({ queryKey: keys.agents, queryFn: () => api.get<AgentsResponse>(paths.agents) });

export function useAgent(id: string): AgentView | undefined {
  return useAgents().data?.find((a) => a.id === id);
}

export const useHarnesses = () =>
  useQuery({ queryKey: keys.harnesses, queryFn: () => api.get<HarnessesResponse>(paths.harnesses) });

export const useDevices = () =>
  useQuery({ queryKey: keys.devices, queryFn: () => api.get<DevicesResponse>(paths.devices) });

export const useConversation = (id: string) =>
  useQuery({
    queryKey: keys.conversation(id),
    queryFn: () => api.get<ConversationResponse>(paths.conversation(id)),
  });

export const useMessages = (conversationId: string, opts: { enabled?: boolean } = {}) =>
  useQuery({
    queryKey: keys.messages(conversationId),
    queryFn: () => api.get<MessagesResponse>(paths.messages(conversationId)),
    enabled: opts.enabled,
  });

export const useInfo = () =>
  useQuery({ queryKey: keys.info, queryFn: () => api.get<InfoResponse>(paths.info) });

/** Fetches the page before the oldest loaded message and prepends it (for infinite scroll). */
export function useLoadOlderMessages(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (before: number) =>
      api.get<MessagesResponse>(`${paths.messages(conversationId)}?before=${before}`),
    onSuccess: (page) => {
      qc.setQueryData<MessagesResponse>(keys.messages(conversationId), (cur) => {
        if (!cur) return cur;
        const seen = new Set(cur.messages.map((m) => m.id));
        const older = page.messages.filter((m) => !seen.has(m.id));
        return { messages: [...older, ...cur.messages], hasMore: page.hasMore };
      });
    },
  });
}

/** Ensures the page containing `seq` is loaded, for ⌘K's jump-to-message. */
export async function ensureMessageLoaded(
  qc: QueryClient,
  conversationId: string,
  seq: number,
): Promise<void> {
  const key = keys.messages(conversationId);
  const cur = qc.getQueryData<MessagesResponse>(key);
  if (cur?.messages.some((m) => m.seq === seq)) return;
  const page = await api.get<MessagesResponse>(`${paths.messages(conversationId)}?before=${seq + 1}`);
  qc.setQueryData<MessagesResponse>(key, (c) => {
    if (!c) return { messages: page.messages, hasMore: page.hasMore };
    const seen = new Set(c.messages.map((m) => m.id));
    const older = page.messages.filter((m) => !seen.has(m.id));
    return { messages: [...older, ...c.messages], hasMore: page.hasMore };
  });
}

export async function searchMessages(q: string, agentId?: string): Promise<MessageSearchHit[]> {
  const params = new URLSearchParams({ q });
  if (agentId) params.set("agentId", agentId);
  return api.get(`${paths.search}?${params}`);
}

// ---- mutations ----------------------------------------------------------------------------------

function upsertAgent(qc: QueryClient, agent: AgentView) {
  qc.setQueryData<AgentsResponse>(keys.agents, (list) =>
    list ? [...list.filter((a) => a.id !== agent.id), agent].sort((a, b) => a.createdAt - b.createdAt) : list,
  );
}

export function useSaveAgent(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentBody | AgentPatchBody) =>
      id ? api.patch<AgentView>(paths.agent(id), body) : api.post<AgentView>(paths.agents, body),
    onSuccess: (agent) => upsertAgent(qc, agent),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(paths.agent(id)),
    onSuccess: (_, id) => qc.setQueryData<AgentsResponse>(keys.agents, (l) => l?.filter((a) => a.id !== id)),
  });
}

export const useSendMessage = (conversationId: string) =>
  useMutation({
    mutationFn: (text: string) => api.post<SendMessageResponse>(paths.messages(conversationId), { text }),
  });

export const useCancel = (conversationId: string) =>
  useMutation({ mutationFn: () => api.post(paths.cancel(conversationId)) });

export const useNewSession = (conversationId: string) =>
  useMutation({ mutationFn: () => api.post(paths.sessions(conversationId)) });

export const useAnswerPermission = () =>
  useMutation({
    mutationFn: (v: { messageId: string; optionId: string }) =>
      api.post(paths.permission(v.messageId), { optionId: v.optionId }),
  });

export const useMarkRead = (conversationId: string) =>
  useMutation({ mutationFn: (seq: number) => api.post(paths.read(conversationId), { seq }) });

export const useProbeHarness = () =>
  useMutation({
    mutationFn: (v: { id: string; deep?: boolean }) =>
      api.post<Harness>(`${paths.harnessProbe(v.id)}${v.deep ? "?deep=1" : ""}`),
  });

function upsertHarness(qc: QueryClient, harness: Harness) {
  qc.setQueryData<HarnessesResponse>(keys.harnesses, (list) =>
    list ? [...list.filter((h) => h.id !== harness.id), harness] : list,
  );
}

export function useSaveHarness(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: HarnessBody | HarnessPatchBody) =>
      id ? api.patch<Harness>(paths.harness(id), body) : api.post<Harness>(paths.harnesses, body),
    onSuccess: (h) => upsertHarness(qc, h),
  });
}

export function useDeleteHarness() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(paths.harness(id)),
    onSuccess: (_, id) =>
      qc.setQueryData<HarnessesResponse>(keys.harnesses, (l) => l?.filter((h) => h.id !== id)),
  });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(paths.device(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.devices }),
  });
}

export function useRenameDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch<DeviceResponse>(paths.device(id), { name }),
    onSuccess: (device) =>
      qc.setQueryData<DevicesResponse>(keys.devices, (l) => l?.map((d) => (d.id === device.id ? device : d))),
  });
}

/** Mints a fresh sign-in link from this device (Settings → Devices → Add device). */
export function useMintLink() {
  return useMutation({
    mutationFn: (label: string | undefined) => api.post<MintLinkResponse>(paths.deviceLinks, { label }),
  });
}

export function useCancelLink() {
  return useMutation({
    mutationFn: (id: string) => api.delete(paths.deviceLink(id)),
  });
}

// ---- MCP servers, agent tools, memories (phase 2a) ----------------------------------------------

export const useMcpServers = () =>
  useQuery({ queryKey: keys.mcpServers, queryFn: () => api.get<McpServersResponse>(mcpPaths.servers) });

function upsertServer(qc: QueryClient, server: McpServerView) {
  qc.setQueryData<McpServersResponse>(keys.mcpServers, (list) =>
    list
      ? list.some((s) => s.id === server.id)
        ? list.map((s) => (s.id === server.id ? server : s))
        : [...list, server]
      : list,
  );
}

export function useSaveMcpServer(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: McpServerBody | McpServerPatchBody) =>
      id
        ? api.patch<McpServerView>(mcpPaths.server(id), body)
        : api.post<McpServerView>(mcpPaths.servers, body),
    onSuccess: (server) => upsertServer(qc, server),
  });
}

export function useDeleteMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(mcpPaths.server(id)),
    onSuccess: (_, id) =>
      qc.setQueryData<McpServersResponse>(keys.mcpServers, (l) => l?.filter((s) => s.id !== id)),
  });
}

export function useRefreshMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<McpServerView>(mcpPaths.serverRefresh(id)),
    onSuccess: (server) => upsertServer(qc, server),
  });
}

/** Start an OAuth sign-in; the caller opens `authorizationUrl` (new tab, or this one on a phone). */
export const useStartMcpOAuth = () =>
  useMutation({
    mutationFn: (v: { id: string; body: McpOAuthStartBody }) =>
      api.post<McpOAuthStartResponse>(mcpPaths.serverOAuth(v.id), v.body),
  });

/** The redirect page's half: hand the authorization server's answer to the server. */
export const useCompleteMcpOAuth = () =>
  useMutation({
    mutationFn: (body: McpOAuthCallbackBody) =>
      api.post<McpOAuthCallbackResponse>(mcpPaths.oauthCallback, body),
  });

export function useDisconnectMcpOAuth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<McpServerView>(mcpPaths.serverOAuth(id)),
    onSuccess: (server) => upsertServer(qc, server),
  });
}

export const useAgentTools = (agentId: string) =>
  useQuery({
    queryKey: keys.agentTools(agentId),
    queryFn: () => api.get<AgentToolsResponse>(mcpPaths.agentTools(agentId)),
  });

export function useSetAgentTool(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentToolsPatchBody) =>
      api.patch<AgentToolsResponse>(mcpPaths.agentTools(agentId), body),
    onSuccess: (groups) => qc.setQueryData(keys.agentTools(agentId), groups),
  });
}

export const useMemories = (scope: string, q: string) =>
  useQuery({
    queryKey: keys.memories(scope, q),
    queryFn: () => {
      const params = new URLSearchParams();
      if (scope) params.set("scope", scope);
      if (q.trim()) params.set("q", q.trim());
      return api.get<MemoriesResponse>(`${mcpPaths.memories}?${params}`);
    },
  });

export function useSaveMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id?: string; body: MemoryBody | MemoryPatchBody }) =>
      v.id ? api.patch<Memory>(mcpPaths.memory(v.id), v.body) : api.post<Memory>(mcpPaths.memories, v.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memories"] }),
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(mcpPaths.memory(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memories"] }),
  });
}

// ---- voice (phase 2b) ---------------------------------------------------------------------------

export const useVoiceSettings = () =>
  useQuery({ queryKey: keys.voiceSettings, queryFn: () => api.get<VoiceSettings>(voicePaths.settings) });

export function useSaveVoiceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: VoiceSettingsPatchBody) => api.patch<VoiceSettings>(voicePaths.settings, patch),
    onSuccess: (s) => {
      qc.setQueryData(keys.voiceSettings, s);
      void qc.invalidateQueries({ queryKey: keys.voices });
    },
  });
}

/** Worker/STT/TTS health. `voice.status` events keep it fresh; `poll` also refreshes the log tail. */
export const useVoiceStatus = (opts: { poll?: boolean } = {}) =>
  useQuery({
    queryKey: keys.voiceStatus,
    queryFn: () => api.get<VoiceStatus>(voicePaths.status),
    refetchInterval: opts.poll ? 5000 : false,
  });

export function useRestartVoiceWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<VoiceStatus>(voicePaths.workerRestart),
    onSuccess: (s) => qc.setQueryData(keys.voiceStatus, s),
  });
}

export function useGpuSpeech() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: GpuSpeechAction) => api.post<VoiceStatus>(voicePaths.gpuSpeech(action)),
    onSuccess: (s) => qc.setQueryData(keys.voiceStatus, s),
  });
}

/** TTS voices for the agent's voice picker (from the TTS server, or the worker's CPU Kokoro). */
export const useVoices = (enabled = true) =>
  useQuery({
    queryKey: keys.voices,
    queryFn: () => api.get<VoicesResponse>(voicePaths.voices),
    enabled,
    retry: false,
    staleTime: 60_000,
  });

/**
 * The STT server's model catalog with each model's status. It lives on the speech server (not in
 * the app), so there are no events: poll every second while a model downloads or loads.
 */
export const useSttModels = () =>
  useQuery({
    queryKey: keys.sttModels,
    queryFn: () => api.get<SttModelsResponse>(voicePaths.sttModels),
    refetchInterval: (q) => {
      const d = q.state.data;
      const busy =
        d && (d.loading || d.models.some((m) => m.status === "downloading" || m.status === "loading"));
      return busy ? 1000 : 10_000;
    },
  });

export type SttModelCommand = SttModelAction | "cancel" | "delete";

export function useSttModelAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: SttModelCommand }) =>
      action === "delete"
        ? api.delete<SttModel>(voicePaths.sttModel(id))
        : action === "cancel"
          ? api.delete<SttModel>(voicePaths.sttModelAction(id, "download"))
          : api.post<SttModel>(voicePaths.sttModelAction(id, action)),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.sttModels });
      void qc.invalidateQueries({ queryKey: keys.voiceStatus });
    },
  });
}

/** The worker's debug turn recordings (only while the setting is on, or some are left). */
export const useRecordings = (enabled: boolean) =>
  useQuery({
    queryKey: keys.recordings,
    queryFn: () => api.get<RecordingsResponse>(voicePaths.recordings),
    enabled,
    retry: false,
    refetchInterval: enabled ? 10_000 : false,
  });

export function useClearRecordings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ deleted: number }>(voicePaths.recordings),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.recordings }),
  });
}

/** Active calls (all devices). `call.upsert` events keep the list current. */
export const useCalls = () =>
  useQuery({ queryKey: keys.calls, queryFn: () => api.get<CallsResponse>(voicePaths.calls) });

/**
 * Call controls work from any tab or device, through the server (the tab holding the media
 * follows, see call-client.ts). The response updates the cache at once, so the UI doesn't depend
 * on the event channel to show that a hang-up or mute worked.
 */
export async function endCall(callId: string): Promise<void> {
  await api.delete(voicePaths.call(callId));
  queryClient.setQueryData<CallsResponse>(keys.calls, (list) => list?.filter((c) => c.id !== callId));
}

export async function setCallMuted(callId: string, muted: boolean): Promise<Call> {
  const call = await api.patch<Call>(voicePaths.call(callId), { muted });
  queryClient.setQueryData<CallsResponse>(keys.calls, (list) =>
    list?.map((c) => (c.id === call.id ? call : c)),
  );
  return call;
}

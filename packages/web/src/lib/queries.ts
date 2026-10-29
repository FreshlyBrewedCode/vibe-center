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
  type ConversationResponse,
  type DevicesResponse,
  type Harness,
  type HarnessesResponse,
  type McpServerBody,
  type McpServerPatchBody,
  type McpServersResponse,
  type McpServerView,
  type MemoriesResponse,
  type Memory,
  type MemoryBody,
  type MemoryPatchBody,
  type MeResponse,
  type MessagesResponse,
  mcpPaths,
  paths,
  type SendMessageResponse,
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
  mcpServers: ["mcp-servers"] as const,
  agentTools: (agentId: string) => ["agent-tools", agentId] as const,
  /** `scope`: an agent id, "shared", or "" for all. */
  memories: (scope: string, q: string) => ["memories", scope, q] as const,
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

export const useMessages = (conversationId: string) =>
  useQuery({
    queryKey: keys.messages(conversationId),
    queryFn: () => api.get<MessagesResponse>(paths.messages(conversationId)),
  });

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

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(paths.device(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.devices }),
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

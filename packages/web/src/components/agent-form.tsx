import { useNavigate } from "@tanstack/react-router";
import {
  type AgentBody,
  type AgentView,
  BUILTIN_SERVER_ID,
  type ConfigOption,
  type ConfigValues,
  type Harness,
  mcpPaths,
} from "@vibe-center/shared";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/mobile-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useHarnesses, useProbeHarness, useSaveAgent } from "@/lib/queries";
import type { AgentTemplate } from "./agent-templates";
import { Combobox } from "./combobox";
import { HealthBadge } from "./health-badge";
import { VoicePicker } from "./voice/voice-picker";

const DEFAULT = "__default__";

const blank: AgentBody = {
  name: "",
  description: "",
  avatar: { emoji: "🤖", color: "#6366f1" },
  systemPrompt: "",
  harnessId: "claude-code",
  model: null,
  options: {},
  cwd: "~",
};

/**
 * Create or edit an agent. Models and other options come from the harness's cached probe.
 * Sections: Profile, Behaviour, Harness & model. (Tool enablement lives in its own
 * `<AgentTools>` block below the form, in the edit route, since it has its own save path.) 2b
 * adds a "Voice" section below Harness & model for the call voice picker.
 */
export function AgentForm({ agent, template }: { agent?: AgentView; template?: AgentTemplate }) {
  const navigate = useNavigate();
  const harnesses = useHarnesses();
  const save = useSaveAgent(agent?.id);
  const probe = useProbeHarness();
  const [form, setForm] = useState<AgentBody>(
    agent ?? (template ? { ...blank, ...template.defaults } : blank),
  );
  const set = (patch: Partial<AgentBody>) => setForm((f) => ({ ...f, ...patch }));

  const harness = harnesses.data?.find((h) => h.id === form.harnessId);
  const configOptions = harness?.probe?.configOptions ?? [];
  const modelOption =
    configOptions.find((o) => o.category === "model") ?? configOptions.find((o) => o.id === "model");
  const otherOptions = configOptions.filter((o) => o !== modelOption);

  // Once the harness's probed model list is known, pick a sensible default for the template
  // (e.g. a "sonnet"-tier model) instead of leaving the harness's own default. Runs once; the
  // user's own choice afterwards is never overwritten.
  const appliedTemplateModel = useRef(false);
  useEffect(() => {
    if (appliedTemplateModel.current || agent || !template?.modelPreference) return;
    if (modelOption?.type !== "select") return;
    appliedTemplateModel.current = true;
    const pref = template.modelPreference.toLowerCase();
    const pick = modelOption.options.find(
      (c) => c.name.toLowerCase().includes(pref) || c.value.toLowerCase().includes(pref),
    );
    if (pick) setForm((f) => ({ ...f, model: pick.value }));
  }, [agent, template, modelOption]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body: AgentBody = {
      name: form.name,
      description: form.description,
      avatar: form.avatar,
      systemPrompt: form.systemPrompt,
      harnessId: form.harnessId,
      model: form.model,
      options: form.options,
      cwd: form.cwd,
      voice: form.voice ?? null,
    };
    save.mutate(body, {
      onSuccess: async (a) => {
        if (!agent && template?.tools) {
          await Promise.all(
            template.tools.map((t) =>
              api
                .patch(mcpPaths.agentTools(a.id), {
                  serverId: BUILTIN_SERVER_ID,
                  tool: t.tool,
                  enabled: t.enabled,
                })
                .catch(() => {}),
            ),
          );
        }
        navigate({ to: "/agents/$agentId", params: { agentId: a.id } });
      },
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-2xl">
      <PageHeader title={agent ? `Edit ${agent.name}` : "New agent"} backTo="/" className="sm:pb-5" />
      <div className="space-y-8 px-3 pb-6 sm:px-8">
        <FormSection title="Profile">
          <div className="flex gap-3">
            <Field label="Emoji" className="w-20">
              <Input
                value={form.avatar.emoji}
                maxLength={16}
                onChange={(e) => set({ avatar: { ...form.avatar, emoji: e.target.value } })}
              />
            </Field>
            <Field label="Color" className="w-20">
              <Input
                type="color"
                value={form.avatar.color}
                className="cursor-pointer p-1"
                onChange={(e) => set({ avatar: { ...form.avatar, color: e.target.value } })}
              />
            </Field>
            <Field label="Name" className="flex-1">
              <Input required value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
          </div>
          <Field label="Description">
            <Input value={form.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
          </Field>
        </FormSection>

        <FormSection title="Behaviour">
          <Field
            label="System prompt"
            hint="Appended to the harness's own prompt where the harness allows it."
          >
            <Textarea
              rows={8}
              className="font-mono text-xs leading-[1.55] sm:text-xs"
              value={form.systemPrompt ?? ""}
              onChange={(e) => set({ systemPrompt: e.target.value })}
            />
          </Field>
        </FormSection>

        <FormSection title="Harness and model">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Harness">
              <Select
                value={form.harnessId}
                onValueChange={(v) => set({ harnessId: v, model: null, options: {} })}
              >
                <SelectTrigger aria-label="Harness" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {harnesses.data?.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {harness && (
                <HarnessStatusLine
                  harness={harness}
                  onProbe={() => probe.mutate({ id: harness.id })}
                  probing={probe.isPending}
                />
              )}
            </Field>
            <Field label="Model">
              {modelOption?.type === "select" ? (
                <OptionSelect
                  option={modelOption}
                  value={form.model ?? null}
                  onChange={(v) => set({ model: v })}
                  label="Model"
                />
              ) : (
                <Input
                  placeholder="Harness default"
                  value={form.model ?? ""}
                  onChange={(e) => set({ model: e.target.value.trim() || null })}
                />
              )}
            </Field>
          </div>
          {otherOptions.length > 0 && (
            <div className="grid gap-5 sm:grid-cols-2">
              {otherOptions.map((o) => (
                <Field key={o.id} label={o.name} hint={o.description ?? undefined}>
                  <ConfigOptionInput
                    option={o}
                    values={form.options ?? {}}
                    onChange={(options) => set({ options })}
                  />
                </Field>
              ))}
            </div>
          )}
          <Field label="Working directory" hint="Absolute path on the server; ~ is your home directory.">
            <Input required value={form.cwd} onChange={(e) => set({ cwd: e.target.value })} />
          </Field>
        </FormSection>

        <FormSection title="Voice">
          <div>
            <Label className="mb-1.5 block">Voice</Label>
            <VoicePicker value={form.voice ?? null} onChange={(voice) => set({ voice })} />
            <p className="mt-1 text-muted-foreground text-xs">How the agent sounds on calls.</p>
          </div>
        </FormSection>

        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>
            {agent ? "Save" : "Create agent"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => history.back()}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="vc-label border-line border-b pb-2">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label className="mb-1.5 block">
        {label}
        {children}
      </Label>
      {hint && <p className="mt-1 text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

function HarnessStatusLine({
  harness,
  onProbe,
  probing,
}: {
  harness: Harness;
  onProbe: () => void;
  probing: boolean;
}) {
  return (
    <div className="mt-1.5 flex items-center gap-2 text-xs">
      <HealthBadge health={harness.health} />
      {!harness.probe && <span className="text-muted-foreground">Not probed yet, models unknown.</span>}
      <Button type="button" size="xs" variant="quiet" disabled={probing} onClick={onProbe}>
        <RefreshCw className={probing ? "size-3 animate-spin" : "size-3"} /> Check
      </Button>
    </div>
  );
}

/** Above this many choices, a plain Select mounts every item and has no search: use a combobox. */
const COMBOBOX_THRESHOLD = 20;

function OptionSelect({
  option,
  value,
  onChange,
  label,
}: {
  option: Extract<ConfigOption, { type: "select" }>;
  value: string | null;
  onChange: (v: string | null) => void;
  label: string;
}) {
  if (option.options.length > COMBOBOX_THRESHOLD) {
    return (
      <Combobox
        ariaLabel={label}
        placeholder="Harness default"
        value={value ?? ""}
        onChange={(v) => onChange(v || null)}
        options={[
          { value: "", label: "Harness default" },
          ...option.options.map((c) => ({ value: c.value, label: c.name, group: c.group })),
        ]}
      />
    );
  }
  const groups = new Map<string, typeof option.options>();
  for (const c of option.options) {
    const g = c.group ?? "";
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  return (
    <Select value={value ?? DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? null : v)}>
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>Harness default</SelectItem>
        {[...groups].map(([group, choices]) => (
          <SelectGroup key={group}>
            {group && <SelectLabel>{group}</SelectLabel>}
            {choices.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function ConfigOptionInput({
  option,
  values,
  onChange,
}: {
  option: ConfigOption;
  values: ConfigValues;
  onChange: (v: ConfigValues) => void;
}) {
  const setValue = (v: string | boolean | null) => {
    const next = { ...values };
    if (v === null) delete next[option.id];
    else next[option.id] = v;
    onChange(next);
  };
  if (option.type === "boolean") {
    const v = values[option.id];
    return (
      <Select
        value={v === undefined ? DEFAULT : String(v)}
        onValueChange={(s) => setValue(s === DEFAULT ? null : s === "true")}
      >
        <SelectTrigger aria-label={option.name} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT}>Harness default</SelectItem>
          <SelectItem value="true">On</SelectItem>
          <SelectItem value="false">Off</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  const v = values[option.id];
  return (
    <OptionSelect
      option={option}
      label={option.name}
      value={typeof v === "string" ? v : null}
      onChange={setValue}
    />
  );
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const mediaKind = StringEnum(["image", "video", "tts"] as const);

function workspaceSetting(suffix: 'BASE_URL' | 'ACCESS_TOKEN'): string | undefined {
  const current = process.env[`PIVANE_WORKSPACE_${suffix}`], legacy = process.env[`PI_WORKSPACE_${suffix}`];
  if (current && legacy && current !== legacy) throw new Error(`Conflicting Pivane workspace ${suffix} configuration`);
  return current || legacy;
}

function workspaceBaseUrl(): string {
  const ownedOrigin = process.env.PI_WORKSPACE_INTERNAL_TOKEN && process.env.PI_WORKSPACE_INTERNAL_ORIGIN;
  return (ownedOrigin || workspaceSetting('BASE_URL') || "http://127.0.0.1:3001").replace(/\/+$/, "");
}

function plannerCurrentState(): Record<string, unknown> {
  const encoded = process.env.PI_MEDIA_CURRENT_BASE64;
  if (!encoded) return {};
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function requestJson(path: string, options: RequestInit = {}): Promise<any> {
  const target = new URL(`${workspaceBaseUrl()}${path}`);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid workspace URL');
  // The process credential is scoped to this instance and planning endpoints only.
  // Independent CLI installations can explicitly configure their own workspace access token.
  const internal = process.env.PI_WORKSPACE_INTERNAL_ORIGIN === target.origin ? process.env.PI_WORKSPACE_INTERNAL_TOKEN : undefined;
  const token = internal || (workspaceSetting('BASE_URL') ? workspaceSetting('ACCESS_TOKEN') : undefined);
  const response = await fetch(target, { ...options, redirect: 'error',
    headers: { ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Pivane HTTP ${response.status}`);
  return data;
}

async function validatePlan(kind: string, plan: Record<string, unknown>, signal?: AbortSignal) {
  const data = await requestJson("/api/media-agent/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, plan, current: plannerCurrentState() }),
    signal
  });
  return data.plan;
}

function planText(plan: any): string {
  const warnings = Array.isArray(plan.warnings) && plan.warnings.length
    ? `\nWarnings: ${plan.warnings.join(" ")}`
    : "";
  return `${plan.summary}\n${plan.jobs.length} ${plan.kind} job(s) validated.${warnings}`;
}

export default function mediaWorkbench(pi: ExtensionAPI) {
  pi.registerTool({
    name: "media_get_connection_schema",
    label: "Media Connection Schema",
    description: "Read supported media provider/model connection protocols and neutral examples before drafting an integration. No credentials or network execution.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const schema = await requestJson("/api/media-agent/connection-schema", { signal });
      return { content: [{ type: "text", text: JSON.stringify(schema) }], details: { schema } };
    }
  });
  pi.registerTool({
    name: "media_plan_connection",
    label: "Media Connection Draft",
    description: "Validate a declarative media model connection draft from supplied API documentation. Supply unsupported reasons and omit model if the protocol is unsupported. Does not save, test a service, or generate media.",
    parameters: Type.Object({ summary: Type.String(), model: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      warnings: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })), unsupported: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })) }),
    async execute(_toolCallId, params, signal) {
      const result = await requestJson("/api/media-agent/connection/validate", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: params, current: plannerCurrentState() }), signal });
      return { content: [{ type: "text", text: result.draft.summary }], details: { plan: result.draft }, terminate: true };
    }
  });
  pi.registerTool({
    name: "media_get_capabilities",
    label: "Media Capabilities",
    description: "Get the current Pivane image, video, or TTS models, presets, controls, defaults, and limits before making a media plan.",
    promptSnippet: "Read current Pivane media capabilities before planning image, video, or speech work",
    promptGuidelines: ["Read media_get_capabilities before generation planning tools; read media_get_connection_schema before media_plan_connection."],
    parameters: Type.Object({ kind: mediaKind }),
    async execute(_toolCallId, params, signal) {
      const capabilities = await requestJson(`/api/media-agent/capabilities/${params.kind}`, { signal });
      return {
        content: [{ type: "text", text: JSON.stringify(capabilities, null, 2) }],
        details: { kind: params.kind, capabilities }
      };
    }
  });

  pi.registerTool({
    name: "media_plan_request",
    label: "Media Request Plan",
    description: "Validate one request using the selected lab model's live parameter definitions. Accepts model-specific and structured JSON parameters. Does not execute or confirm a generation.",
    parameters: Type.Object({
      modelId: Type.String(),
      summary: Type.String(),
      parameters: Type.Record(Type.String(), Type.Unknown())
    }),
    async execute(_toolCallId, params, signal) {
      const current = plannerCurrentState();
      if (current.modelId && params.modelId !== current.modelId) throw new Error("Keep the selected media model");
      const plan = await validatePlan(process.env.PI_MEDIA_KIND || "image", params, signal);
      return { content: [{ type: "text", text: planText(plan) }], details: { plan }, terminate: true };
    }
  });

  pi.registerTool({
    name: "media_plan_image",
    label: "Image Plan",
    description: "Create and validate a Z-Image or Flux 2 Dev generation plan. This does not generate images.",
    parameters: Type.Object({
      summary: Type.String(),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      model: Type.Optional(Type.String()),
      prompt: Type.String(),
      promptVariants: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
      negative: Type.Optional(Type.String()),
      width: Type.Optional(Type.Integer()),
      height: Type.Optional(Type.Integer()),
      steps: Type.Optional(Type.Integer()),
      cfg: Type.Optional(Type.Number()),
      seed: Type.Optional(Type.Integer()),
      loraEnabled: Type.Optional(Type.Boolean()),
      loraName: Type.Optional(Type.String()),
      loraStrength: Type.Optional(Type.Number())
    }),
    async execute(_toolCallId, params, signal) {
      const plan = await validatePlan("image", params, signal);
      return { content: [{ type: "text", text: planText(plan) }], details: { plan }, terminate: true };
    }
  });

  pi.registerTool({
    name: "media_plan_video",
    label: "Video Plan",
    description: "Create and validate a MiniMax H3 text-to-video or image-to-video plan. This does not generate videos.",
    parameters: Type.Object({
      summary: Type.String(),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      model: Type.Optional(Type.String()),
      prompt: Type.String(),
      promptVariants: Type.Optional(Type.Array(Type.String(), { maxItems: 3 })),
      resolution: Type.Optional(Type.String()),
      duration: Type.Optional(Type.Integer()),
      ratio: Type.Optional(Type.String())
    }),
    async execute(_toolCallId, params, signal) {
      const plan = await validatePlan("video", params, signal);
      return { content: [{ type: "text", text: planText(plan) }], details: { plan }, terminate: true };
    }
  });

  pi.registerTool({
    name: "media_plan_tts",
    label: "Speech Plan",
    description: "Create and validate a Pivane speech plan using the current dynamic TTS Provider registry. This does not synthesize audio.",
    parameters: Type.Object({
      summary: Type.String(),
      text: Type.Optional(Type.String()),
      segments: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      voice: Type.Optional(Type.String()),
      language: Type.Optional(Type.String()),
      speed: Type.Optional(Type.Number()),
      options: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]))),
      instruction: Type.Optional(Type.String()),
      instruct: Type.Optional(Type.String()),
      cfgScale: Type.Optional(Type.Number()),
      seed: Type.Optional(Type.Integer())
    }),
    async execute(_toolCallId, params, signal) {
      const plan = await validatePlan("tts", params, signal);
      return { content: [{ type: "text", text: planText(plan) }], details: { plan }, terminate: true };
    }
  });
}

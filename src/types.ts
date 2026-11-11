import type { Readable } from "node:stream";
export type VideoInput = string | Buffer | Readable | Blob;
export type Capability = "vision" | "transcription";
export type Policy =
  "strict" | "user-only" | "automatic" | "local-only" | "disabled";
export interface Capabilities {
  images?: boolean;
  multipleImages?: boolean;
  ocr?: boolean;
  objects?: boolean;
  activities?: boolean;
  timestamps?: boolean;
  words?: boolean;
  diarization?: boolean;
  maxBytes?: number;
  imageFormats?: string[];
}
export interface Segment {
  start?: number;
  end?: number;
  text: string;
  speaker?: string;
  confidence?: number;
  words?: Array<{ start: number; end: number; text: string }>;
}
export interface Visual {
  description: string;
  objects?: Array<{ label: string; confidence?: number }>;
  text?: Array<{ text: string; confidence?: number }>;
  environment?: string;
  composition?: string;
  categories?: string[];
  activities?: Array<{
    description: string;
    frameIndices: number[];
    confidence?: number;
  }>;
}
export interface Transcript {
  text: string;
  language?: string;
  segments: Segment[];
  precision: "word" | "segment" | "chunk" | "unavailable";
}
export interface MediaRequest {
  capability: Capability;
  files: string[];
  timestamps: number[];
  duration?: number;
  language?: string;
  prompt: string;
  signal: AbortSignal;
}
export interface Provider {
  id: string;
  model: string;
  location: "local" | "external";
  shared?: boolean;
  capability: Capability;
  capabilities: Capabilities;
  run(request: MediaRequest): Promise<Visual | Transcript>;
  cacheIdentity?: string;
}
export interface Attempt {
  provider: string;
  model: string;
  status: "success" | "failure" | "circuit-open";
  code?: string;
  durationMs: number;
}
export interface Provenance {
  primary: string;
  successful?: string;
  model?: string;
  attempts: Attempt[];
  fallbackUsed: boolean;
  durationMs: number;
  cacheHit?: boolean;
  cacheWriteFailed?: boolean;
}
export interface Metadata {
  duration: number;
  fileSize: number;
  format?: string;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  fps?: number;
  averageFps?: number;
  pixelFormat?: string;
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
  rotation?: number;
  streamCount: number;
  startTime?: number;
  raw: unknown;
}
export interface Frame {
  id: string;
  timestamp: number;
  sourceTimestamp: number;
  frameNumber?: number;
  width: number;
  height: number;
  format: "jpeg";
  path?: string;
  sceneId?: string;
}
export interface Evidence {
  id: string;
  kind: "frame" | "audio" | "scene";
  start: number;
  end?: number;
  sourceTimestamp: number;
}
export interface Observation {
  id: string;
  kind:
    | "description"
    | "object"
    | "ocr"
    | "activity"
    | "environment"
    | "composition"
    | "classification";
  text: string;
  start: number;
  end?: number;
  evidence: string[];
  basis: "provider-observation" | "inference";
  confidence?: number;
  provenance: Provenance;
}
export interface Scene {
  id: string;
  start: number;
  end: number;
  duration: number;
  frames: string[];
  observations: string[];
}
export interface TimelineEntry {
  timestamp: number;
  end?: number;
  type: string;
  description: string;
  evidence: string[];
}
export interface VideoAnalysis {
  schemaVersion: "1.0";
  sourceHash: string;
  metadata: Metadata;
  scenes: Scene[];
  frames: Frame[];
  evidence: Evidence[];
  transcript: Transcript & { provenance: Provenance[] };
  observations: Observation[];
  textOnScreen: Observation[];
  events: TimelineEntry[];
  timeline: TimelineEntry[];
  coverage: {
    processedUntil: number;
    sampledTimestamps: number[];
    visualGaps: Array<{ start: number; end: number }>;
    note: string;
    truncated: boolean;
  };
  status: Record<
    Capability,
    | "disabled"
    | "unconfigured"
    | "complete"
    | "partial"
    | "failed"
    | "unavailable"
  >;
  processing: {
    durationMs: number;
    requests: number;
    warnings: string[];
    providersUsed: string[];
    fallbacksUsed: boolean;
    failures: Array<{
      capability: Capability;
      code: string;
      provenance?: Provenance;
    }>;
    capabilities: Array<{
      id: string;
      model: string;
      capability: Capability;
      location: Provider["location"];
      declared: Capabilities;
    }>;
    costEstimate?: { amount: number; currency: string; basis: string };
  };
}
export interface Sampling {
  mode?:
    | "fixed"
    | "fps"
    | "scene"
    | "adaptive"
    | "custom"
    | "first"
    | "last"
    | "middle";
  interval?: number;
  fps?: number;
  timestamps?: number[];
  maxFrames?: number;
  maxDimension?: number;
  quality?: number;
}
export interface Progress {
  stage: string;
  completed?: number;
  total?: number;
  message?: string;
}
export interface CapabilityConfig {
  policy?: Policy;
  providers?: Provider[];
}
export interface VIEConfig {
  ffmpeg?: string;
  ffprobe?: string;
  tempDir?: string;
  retain?: boolean;
  maxInputBytes?: number;
  allowRemote?: boolean;
  maxDuration?: number;
  maxRuntimeMs?: number;
  maxRequests?: number;
  maxRetries?: number;
  retryBudget?: number;
  concurrency?: number;
  timeoutMs?: number;
  backoffMs?: number;
  circuitThreshold?: number;
  circuitRecoveryMs?: number;
  sampling?: Sampling;
  sceneThreshold?: number;
  audioChunkSeconds?: number;
  language?: string;
  vision?: CapabilityConfig;
  transcription?: CapabilityConfig;
  sharedFallbackEnabled?: boolean;
  ocr?: boolean;
  objects?: boolean;
  actions?: boolean;
  cacheDir?: string;
  cacheNamespace?: string;
  pricing?: Record<string, { perRequest: number; currency: string }>;
  onProgress?: (event: Progress) => void;
}
export interface AnalyzeOptions {
  signal?: AbortSignal;
  checkpointPath?: string;
}

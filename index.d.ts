export type TimingMode = "word" | "segment" | "proportional";

/** Speech-to-text providers. Anthropic is absent: Claude has no audio input. */
export type AsrProviderId = "openai" | "gemini";

/** Text providers for summaries and enrichment. All three work here. */
export type LlmProviderId = "openai" | "anthropic" | "gemini";
export type SourceType = "youtube" | "local";

export interface Word {
  w: string;
  s: number;
  e: number;
  conf?: number;
}

export interface Segment {
  id: string;
  index: number;
  start: number;
  end: number;
  text: string;
  shortTitle: string | null;
  speaker: string | null;
  confidence: number;
  meaningful: boolean;
  score: number;
  keywords: string[];
  words: Word[];
  /** True when start/end were interpolated rather than measured. */
  approximate: boolean;
  sourceChunk: number | null;
}

export interface TimingInfo {
  mode: TimingMode;
  toleranceSec: number;
  chunkSeconds: number;
  overlapSec: number;
  note: string | null;
}

export interface ProgressEvent {
  stage: "metadata" | "download" | "convert" | "split" | "transcribe" | "enrich";
  done: number;
  total: number;
}

export interface SegmentationOptions {
  gapSec?: number;
  minWords?: number;
  maxWords?: number;
  maxDurationSec?: number;
  minConfidence?: number;
}

export interface TranscribeOptions {
  apiKey?: string;
  language?: string;
  /** Overrides ASR_PROVIDER. Only openai supports timingMode "word". */
  asrProvider?: AsrProviderId;
  /** Overrides LLM_PROVIDER for the enrichment pass. */
  llmProvider?: LlmProviderId;
  /** Defaults to "word". */
  timingMode?: TimingMode;
  model?: string;
  enrichModel?: string;
  /** Overrides the default ASR prompt entirely. */
  prompt?: string;
  /** Domain terms appended to the default prompt. */
  vocabulary?: string[];
  workDir?: string;
  cacheDir?: string;
  cache?: boolean;
  /** Batched LLM pass for shortTitle/keywords/meaningful. Default true. */
  enrich?: boolean;
  chunkSeconds?: number;
  overlapSec?: number;
  concurrency?: number;
  segmentation?: SegmentationOptions;
  cookiesFile?: string;
  proxy?: string;
  strictMetadata?: boolean;
  verbose?: boolean;
  onProgress?: (event: ProgressEvent) => void;
}

export interface TranscriptionResult {
  sourceType: SourceType;
  videoId: string | null;
  url: string | null;
  embedUrl: string | null;
  inputPath: string | null;
  title: string;
  thumbnail: string | null;
  mp3Path: string;
  durationSec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  audioSha256: string;
  language: string;
  engine: string;
  providers: { asr: AsrProviderId; llm: LlmProviderId | null };
  timing: TimingInfo;
  stats: {
    segmentsTotal: number;
    segmentsMeaningful: number;
    avgConfidence: number;
  };
  text: string;
  segments: Segment[];
}

export interface ResolvedSource {
  sourceType: SourceType;
  videoId: string | null;
  url?: string;
  embedUrl?: string;
  startSec?: number | null;
  inputPath?: string;
  title: string;
  thumbnail?: string;
  durationSec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  aspect?: number | null;
  mp3Path: string;
}

export interface ParsedYouTube {
  videoId: string;
  startSec: number | null;
  originalUrl: string;
}

export interface YoutubeMetadata extends ParsedYouTube {
  title: string;
  durationSec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  uploader: string | null;
  thumbnail: string;
  isLive: boolean;
  availability: string | null;
  embedUrl: string;
}

export interface EmbedOptions {
  enableJsApi?: boolean;
  /** Must equal window.location.origin or the IFrame API stays silent. */
  origin?: string;
  startSec?: number | null;
  autoplay?: boolean;
  controls?: boolean;
  noCookie?: boolean;
  hl?: string;
}

export interface MediaInfo {
  durationSec: number;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  aspect: number | null;
  fps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
}

export interface WriteOutputsOptions {
  outputDir?: string;
  baseName?: string;
  projectId?: string;
  dir?: "rtl" | "ltr";
  srt?: boolean;
}

export interface WrittenFiles {
  transcriptJson: string;
  vtt: string;
  srt?: string;
  txt: string;
}

export interface VttOptions {
  language?: string;
  meaningfulOnly?: boolean;
  wrapAt?: number;
  note?: string | null;
}

export interface DraftSegment {
  start: number;
  end: number;
  text: string;
  words: Word[];
  confidence: number;
  sourceChunk?: number | null;
}

/* -------------------------------------------------------------- */

export function transcribeToSegments(
  source: string,
  options?: TranscribeOptions
): Promise<TranscriptionResult>;

export function resolveSource(
  source: string,
  options?: TranscribeOptions
): Promise<ResolvedSource>;

export function writeOutputs(
  result: TranscriptionResult,
  options?: WriteOutputsOptions
): Promise<WrittenFiles>;

export function parseYouTubeUrl(input: string): ParsedYouTube | null;
export function isYoutubeUrl(value: unknown): boolean;
export function youtubeEmbedUrl(videoId: string, options?: EmbedOptions): string;
export function youtubeThumbUrl(
  videoId: string,
  quality?: "default" | "mq" | "hq" | "sd" | "maxres"
): string;
export function getYoutubeMetadata(input: string): Promise<YoutubeMetadata>;
export function downloadYoutubeAsMp3(
  videoUrl: string,
  outputDir?: string,
  options?: { reuse?: boolean; cookiesFile?: string; proxy?: string; verbose?: boolean }
): Promise<string>;

export function probeMedia(filePath: string): Promise<MediaInfo>;
export function probeDurationSec(filePath: string): Promise<number>;
export function convertToMp3IfNeeded(
  inputPath: string,
  options?: { outputDir?: string; sampleRate?: number; bitrate?: string }
): Promise<string>;
export function splitWithOverlap(
  mp3Path: string,
  options?: { chunkDir?: string; chunkSeconds?: number; overlapSec?: number; durationSec?: number }
): Promise<{
  chunks: Array<{ index: number; file: string; startSec: number; sizeBytes: number }>;
  durationSec: number;
  chunkSeconds: number;
  overlapSec: number;
}>;

/**
 * Model tier for a text call.
 *
 *   fast   the small model — the default, and correct for bulk work
 *   heavy  the larger model, for input the small one measurably struggles with
 *
 * Configured per provider as `<PROVIDER>_LLM_MODEL` and
 * `<PROVIDER>_LLM_MODEL_HEAVY`.
 */
export type ModelTier = "fast" | "heavy";

export function summarizeText(
  text: string,
  options?: {
    provider?: LlmProviderId;
    language?: string;
    style?: "concise" | "detailed";
    model?: string;
    /** Pin a tier. Omit to let the escalation policy decide. */
    tier?: ModelTier;
    maxTokens?: number;
    prompt?: string;
  }
): Promise<string>;

export function enrichSegments(
  segments: Segment[],
  options?: {
    provider?: LlmProviderId;
    language?: string;
    model?: string;
    /** Pin a tier. Omit to get fast, with a heavy retry for failed batches. */
    tier?: ModelTier;
    maxTokens?: number;
    batchSize?: number;
  }
): Promise<Segment[]>;

/**
 * The escalation policy, exposed so callers can predict a run's cost.
 * Honours TRANSCRIBER_LLM_ESCALATE: auto (default) | never | always.
 */
export function chooseTier(input?: { complex?: boolean; retry?: boolean }): ModelTier;

/**
 * Load a .env into process.env, searching upward from the current directory.
 * Called on import; call it explicitly from a process that reads process.env
 * at module scope, before those modules are evaluated.
 */
export function loadEnv(envPath?: string): NodeJS.ProcessEnv;

export function dedupeOverlap(words: Word[], toleranceSec?: number): Word[];
export function mergeWordsToSentences(
  words: Word[],
  options?: SegmentationOptions
): DraftSegment[];
export function distributeSentencesOverWindow(
  text: string,
  windowStart: number,
  windowEnd: number
): DraftSegment[];
export function toSegments(
  drafts: DraftSegment[],
  options?: { timingMode?: TimingMode; idPrefix?: string; segmentation?: SegmentationOptions }
): Segment[];
export function toVTT(segments: Segment[], options?: VttOptions): string;
export function toSRT(segments: Segment[], meaningfulOnly?: boolean): string;
export function timecode(seconds: number, withMs?: boolean): string;

/** @deprecated v1 shape — no timing data. Use transcribeToSegments. */
export function transcribe(
  source: string,
  options?: TranscribeOptions & WriteOutputsOptions
): Promise<{
  sourceType: SourceType;
  url: string | null;
  inputPath: string | null;
  mp3Path: string;
  transcriptText: string;
  transcriptFile: string;
  segments: Segment[];
  timing: TimingInfo;
}>;

/** @deprecated Use transcribeToSegments. */
export function transcribeYoutube(
  url: string,
  options?: TranscribeOptions & WriteOutputsOptions
): ReturnType<typeof transcribe>;

/** @deprecated Use transcribeToSegments. */
export function transcribeLocalFile(
  inputPath: string,
  options?: TranscribeOptions & WriteOutputsOptions
): ReturnType<typeof transcribe>;

export interface TimingCapability {
  supported: boolean;
  toleranceSec?: number;
  reason?: string;
}

export interface ProviderRegistry {
  asr: Array<{
    id: AsrProviderId;
    label: string;
    keyEnv: string;
    keyPresent: boolean;
    maxUploadBytes: number;
    timingModes: Record<TimingMode, TimingCapability>;
  }>;
  llm: Array<{
    id: LlmProviderId;
    label: string;
    keyEnv: string;
    keyPresent: boolean;
    defaultModel: string;
    heavyModel: string;
  }>;
  unsupported: Array<{ axis: "asr"; id: string; reason: string }>;
  selected: { asr: string; llm: string };
  escalate: string;
}

/** Capability matrix plus which keys are actually present in the environment. */
export function listProviders(): ProviderRegistry;

/** Throws if the selected providers are unknown or missing their API keys. */
export function assertConfigured(options?: {
  asr?: AsrProviderId;
  llm?: LlmProviderId;
}): true;

export function getAsrProvider(name?: string): {
  id: AsrProviderId;
  label: string;
  keyEnv: string;
  maxUploadBytes: number;
  capabilities: Record<TimingMode, TimingCapability>;
};

export function getLlmProvider(name?: string): {
  id: LlmProviderId;
  label: string;
  keyEnv: string;
  defaultModel(): string;
  heavyModel(): string;
  complete(input: {
    system: string;
    user: string;
    model?: string;
    tier?: ModelTier;
    maxTokens?: number;
    json?: boolean;
  }): Promise<string>;
};

/** Fallback only — the real value comes from the selected ASR provider. */
export const TIMING_TOLERANCE_SEC: Record<TimingMode, number>;

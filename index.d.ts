export interface SummarizeTextOptions {
  apiKey?: string;
  language?: string;
  style?: "concise" | "detailed";
  model?: string;
  prompt?: string;
}

export interface FamilySummaryOptions {
  apiKey?: string;
  title?: string;
  transcriptText: string;
  summaryText?: string;
  outputHtmlPath?: string;
  outputPdfPath?: string;
}

export interface FamilySummaryResult {
  title: string;
  summaryText: string;
  html: string;
  htmlPath?: string;
  pdfPath?: string;
}

export interface TranscribeOptions {
  apiKey?: string;
  language?: string;
  outputDir?: string;
  chunkDir?: string;
  downloadDir?: string;
  familySummary?: boolean;
  familySummaryHtmlPath?: string;
  familySummaryPdfPath?: string;
  title?: string;
}

export interface TranscriptionResult {
  sourceType: "local" | "youtube";
  inputPath?: string;
  url?: string;
  mp3Path: string;
  transcriptText: string;
  summaryText: string;
  transcriptFile: string;
  summaryFile: string;
  chunkFiles: string[];
  familySummary?: FamilySummaryResult;
}

export function convertToMp3IfNeeded(inputPath: string, options?: { outputDir?: string }): Promise<string>;
export function createFamilySummary(options: FamilySummaryOptions): Promise<FamilySummaryResult>;
export function downloadYoutubeAsMp3(videoUrl: string, outputDir?: string): Promise<string>;
export function summarizeText(text: string, options?: SummarizeTextOptions): Promise<string>;
export function transcribe(source: string, options?: TranscribeOptions): Promise<TranscriptionResult>;
export function transcribeLocalFile(inputPath: string, options?: TranscribeOptions): Promise<TranscriptionResult>;
export function transcribeMp3(
  mp3Path: string,
  options?: {
    apiKey?: string;
    outputDir?: string;
    chunkDir?: string;
    language?: string;
  }
): Promise<{
  chunkFiles: string[];
  outputFile: string;
  summaryFile: string;
}>;
export function transcribeYoutube(url: string, options?: TranscribeOptions): Promise<TranscriptionResult>;

declare const _default: {
  convertToMp3IfNeeded: typeof convertToMp3IfNeeded;
  createFamilySummary: typeof createFamilySummary;
  downloadYoutubeAsMp3: typeof downloadYoutubeAsMp3;
  summarizeText: typeof summarizeText;
  transcribe: typeof transcribe;
  transcribeLocalFile: typeof transcribeLocalFile;
  transcribeMp3: typeof transcribeMp3;
  transcribeYoutube: typeof transcribeYoutube;
};

export default _default;

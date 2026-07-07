import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./spec";
import type { GeneratedFile } from "./types";

export const DEFAULT_MODEL = "claude-sonnet-5";

export interface GenerateResult {
  files: GeneratedFile[];
  rawText: string;
  inputTokens: number;
  outputTokens: number;
}

const FILE_BLOCK_RE = /```file:(\S+)\n([\s\S]*?)```/g;

export function parseFiles(text: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const match of text.matchAll(FILE_BLOCK_RE)) {
    const [, path, contents] = match;
    files.push({ path: path.trim(), contents });
  }
  return files;
}

export async function generateCode(
  apiKey: string,
  model: string,
  messages: Anthropic.MessageParam[],
): Promise<GenerateResult> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages,
  });

  const rawText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const files = parseFiles(rawText);

  return {
    files,
    rawText,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

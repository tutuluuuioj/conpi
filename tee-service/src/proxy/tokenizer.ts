import { countTokens as countAnthropicTokens } from "@anthropic-ai/tokenizer";
import { encodingForModel, getEncoding, Tiktoken } from "js-tiktoken";

const encoders = new Map<string, Tiktoken>();

function openAiEncoder(model: string): Tiktoken {
  const cached = encoders.get(model);
  if (cached) return cached;

  let encoder: Tiktoken;
  try {
    encoder = encodingForModel(model as any);
  } catch {
    encoder = getEncoding(model.startsWith("gpt-4o") ? "o200k_base" : "cl100k_base");
  }
  encoders.set(model, encoder);
  return encoder;
}

export function countTextTokens(provider: string, model: string, text: string): number {
  if (!text) return 0;
  if (provider.toLowerCase() === "anthropic" || model.toLowerCase().startsWith("claude")) {
    return countAnthropicTokens(text.normalize("NFKC"));
  }
  return openAiEncoder(model).encode(text.normalize("NFKC")).length;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part: any) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return JSON.stringify(part);
    })
    .join("\n");
}

export function countChatInputTokens(
  provider: string,
  model: string,
  messages: unknown,
  system?: unknown
): number {
  const rows = Array.isArray(messages) ? messages : [];
  let total = system ? countTextTokens(provider, model, contentToText(system)) : 0;
  for (const message of rows as any[]) {
    total += 4;
    total += countTextTokens(provider, model, String(message?.role || "user"));
    total += countTextTokens(provider, model, contentToText(message?.content));
  }
  return total + 2;
}

export function countEmbeddingInputTokens(provider: string, model: string, input: unknown): number {
  if (Array.isArray(input)) {
    return input.reduce((sum, item) => sum + countTextTokens(provider, model, contentToText(item)), 0);
  }
  return countTextTokens(provider, model, contentToText(input));
}

export function extractText(content: unknown): string {
  return contentToText(content);
}

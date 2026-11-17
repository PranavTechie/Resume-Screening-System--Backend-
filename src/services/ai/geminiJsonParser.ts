/**
 * geminiJsonParser.ts
 *
 * Robust JSON extraction, sanitization, and parsing utility specifically
 * designed for LLM / Gemini API responses.
 *
 * Handles:
 * - Markdown fences (```json ... ```, ``` ... ```)
 * - Leading / trailing conversational commentary
 * - Trailing commas before closing braces/brackets
 * - Incomplete or truncated JSON objects / strings (repairing open quotes/brackets)
 */

import { logger } from '../../utils/logger';

/**
 * Strips markdown code fences and extracts candidate JSON substring.
 */
export function cleanGeminiRawText(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';

  let cleaned = raw.trim();

  // 1. Remove standard markdown fences ```json ... ``` or ``` ... ```
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/i, '');
  cleaned = cleaned.trim();

  // 2. If fences were embedded inside conversational text:
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1].trim();
  }

  // 3. If there is still outer text, locate the outermost JSON object or array
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');

  let startIndex = -1;
  let isObject = false;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIndex = firstBrace;
    isObject = true;
  } else if (firstBracket !== -1) {
    startIndex = firstBracket;
    isObject = false;
  }

  if (startIndex !== -1) {
    const endChar = isObject ? '}' : ']';
    const lastIndex = cleaned.lastIndexOf(endChar);
    if (lastIndex > startIndex) {
      cleaned = cleaned.slice(startIndex, lastIndex + 1);
    } else {
      // Unclosed object/array - take everything from startIndex for repair
      cleaned = cleaned.slice(startIndex);
    }
  }

  return cleaned.trim();
}

/**
 * Removes trailing commas in objects and arrays (e.g. `[1, 2, ]` or `{"a": 1, }`).
 */
export function stripTrailingCommas(jsonString: string): string {
  return jsonString.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Attempts to repair truncated JSON caused by token cutoff or network termination.
 * Closes unclosed quotes, removes trailing commas/colons, and closes open brackets/braces.
 */
export function repairTruncatedJson(jsonString: string): string {
  if (!jsonString || typeof jsonString !== 'string') return jsonString;

  let inString = false;
  let isEscaped = false;
  const stack: string[] = [];

  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        stack.push('}');
      } else if (char === '[') {
        stack.push(']');
      } else if (char === '}' || char === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === char) {
          stack.pop();
        }
      }
    }
  }

  let repaired = jsonString;

  // If we ended inside an open string, close it
  if (inString) {
    repaired += '"';
  }

  // Trim trailing incomplete keys, colons, or commas
  repaired = repaired.replace(/,\s*$/, '');
  repaired = repaired.replace(/:\s*$/, ': null');
  repaired = repaired.replace(/,\s*$/, '');

  // Remove any trailing commas that might now precede closures
  repaired = stripTrailingCommas(repaired);

  // Close remaining open objects/arrays in reverse order
  while (stack.length > 0) {
    const closing = stack.pop();
    repaired += closing;
  }

  return stripTrailingCommas(repaired);
}

/**
 * Parse Gemini response into JSON safely with multiple recovery tiers.
 *
 * @throws Error if parsing fails completely across all tiers
 */
export function parseGeminiJson<T = any>(rawText: string, contextDescription: string = 'Gemini'): T {
  if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error(`GEMINI_VALIDATION_FAILED: ${contextDescription} returned empty content.`);
  }

  const trimmed = rawText.trim();

  // Tier 1: Direct JSON.parse (cleanest & fastest)
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Continue to Tier 2
  }

  // Tier 2: Strip markdown fences & conversational outer text
  const cleaned = cleanGeminiRawText(trimmed);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Continue to Tier 3
  }

  // Tier 3: Strip trailing commas
  const commaStripped = stripTrailingCommas(cleaned);
  try {
    return JSON.parse(commaStripped) as T;
  } catch {
    // Continue to Tier 4
  }

  // Tier 4: Repair truncated JSON (token limit cutoff / unclosed delimiters)
  const repaired = repairTruncatedJson(commaStripped);
  try {
    const parsed = JSON.parse(repaired) as T;
    logger.warn(`[GeminiJsonParser] Successfully parsed JSON via truncation repair for ${contextDescription}`);
    return parsed;
  } catch (err: any) {
    logger.error(`[GeminiJsonParser] Failed to parse JSON across all recovery tiers for ${contextDescription}. Raw sample: ${trimmed.slice(0, 200)}... Error: ${err.message}`);
    throw new Error(`GEMINI_VALIDATION_FAILED: Invalid JSON returned by Gemini (${err.message})`);
  }
}

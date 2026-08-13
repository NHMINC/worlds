/**
 * AI provider interface. The only implementation today talks to xAI's
 * OpenAI-compatible chat endpoint using a key the user pastes in Settings
 * (kept in localStorage, never sent anywhere else).
 */
export interface NameContext {
  kind: 'place' | 'city' | 'town' | 'landmark';
  biome: string;
  worldName: string;
  existing: string[];
}

export interface AIProvider {
  suggestNames(ctx: NameContext): Promise<string[]>;
}

const KEY_STORAGE = 'wb_xai_key';
const MODEL_STORAGE = 'wb_xai_model';
const DEFAULT_MODEL = 'grok-3-mini';
const MAX_KEY = 256;
const MAX_MODEL = 80;
const MAX_NAME = 80;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function getAIKey(): string {
  return localStorage.getItem(KEY_STORAGE) ?? '';
}

export function setAIKey(key: string): void {
  const trimmed = key.trim().slice(0, MAX_KEY);
  if (trimmed) localStorage.setItem(KEY_STORAGE, trimmed);
  else localStorage.removeItem(KEY_STORAGE);
}

export function getAIModel(): string {
  return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL;
}

export function setAIModel(model: string): void {
  const trimmed = model.trim().slice(0, MAX_MODEL);
  if (trimmed) localStorage.setItem(MODEL_STORAGE, trimmed);
  else localStorage.removeItem(MODEL_STORAGE);
}

class XAIProvider implements AIProvider {
  private key: string;
  private model: string;

  constructor(key: string, model: string) {
    this.key = key;
    this.model = model;
  }

  async suggestNames(ctx: NameContext): Promise<string[]> {
    const prompt =
      `Suggest 6 evocative, calm fantasy names for a ${ctx.kind} located in a "${ctx.biome.slice(0, MAX_NAME)}" ` +
      `biome, in an earthlike world called "${ctx.worldName.slice(0, MAX_NAME)}". ` +
      (ctx.existing.length
        ? `Existing names nearby: ${ctx.existing.slice(0, 12).map((n) => n.slice(0, MAX_NAME)).join(', ')}. Match their tone. `
        : '') +
      `Reply with ONLY a JSON array of 6 strings, no other text.`;

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.key}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`xAI request failed (${res.status})`);
    const data: unknown = await res.json();
    const text =
      isRecord(data) && Array.isArray(data.choices) && isRecord(data.choices[0]) && isRecord(data.choices[0].message)
        ? data.choices[0].message.content
        : '[]';
    const match = typeof text === 'string' ? text.match(/\[[\s\S]*\]/) : null;
    if (!match) throw new Error('Unexpected AI response');
    let names: unknown;
    try {
      names = JSON.parse(match[0]);
    } catch {
      throw new Error('Unexpected AI response');
    }
    if (!Array.isArray(names)) throw new Error('Unexpected AI response');
    return names
      .filter((n): n is string => typeof n === 'string')
      .map((n) => n.trim().slice(0, MAX_NAME))
      .filter(Boolean)
      .slice(0, 6);
  }
}

/** Returns null when no API key is configured. */
export function getAIProvider(): AIProvider | null {
  const key = getAIKey();
  if (!key) return null;
  return new XAIProvider(key, getAIModel());
}

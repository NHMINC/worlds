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

export function getAIKey(): string {
  return localStorage.getItem(KEY_STORAGE) ?? '';
}

export function setAIKey(key: string): void {
  if (key) localStorage.setItem(KEY_STORAGE, key);
  else localStorage.removeItem(KEY_STORAGE);
}

export function getAIModel(): string {
  return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL;
}

export function setAIModel(model: string): void {
  if (model) localStorage.setItem(MODEL_STORAGE, model);
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
      `Suggest 6 evocative, calm fantasy names for a ${ctx.kind} located in a "${ctx.biome}" ` +
      `biome, in an earthlike world called "${ctx.worldName}". ` +
      (ctx.existing.length ? `Existing names nearby: ${ctx.existing.join(', ')}. Match their tone. ` : '') +
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
    });
    if (!res.ok) throw new Error(`xAI request failed (${res.status})`);
    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content ?? '[]';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Unexpected AI response');
    const names = JSON.parse(match[0]);
    if (!Array.isArray(names)) throw new Error('Unexpected AI response');
    return names.map(String).slice(0, 6);
  }
}

/** Returns null when no API key is configured. */
export function getAIProvider(): AIProvider | null {
  const key = getAIKey();
  if (!key) return null;
  return new XAIProvider(key, getAIModel());
}

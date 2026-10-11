/**
 * Automatic translation of the menu texts (names, descriptions, courses) into the restaurant's other
 * languages. The model only ever sees short menu texts, never customer data. What it returns is
 * checked (known ids, asked languages, sane length) before anything is saved, and a translation
 * never overwrites a text somebody already wrote.
 */
const { LANGUAGE_NAMES } = require('../lib/constants');

const CHUNK = 40;            // texts per request to the model
const MAX_TEXT = 600;
const KINDS = ['category', 'dish', 'description', 'course', 'option', 'title', 'note'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['translations'],
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'lang', 'text'],
        properties: { id: { type: 'string' }, lang: { type: 'string' }, text: { type: 'string' } },
      },
    },
  },
};

class TranslationError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function outputText(response) {
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'refusal') throw new TranslationError('El proveedor de IA ha rechazado la petición');
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  throw new TranslationError('El proveedor de IA no ha devuelto contenido');
}

class OpenAITranslationProvider {
  /** items: [{ id, kind, text, targets: ['en', …] }] → [{ id, lang, text }] */
  async translate({ from, items }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new TranslationError('La traducción automática no está configurada', 503);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.MENU_AI_TIMEOUT_MS || 60000));
    let response;
    try {
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: process.env.OPENAI_TRANSLATE_MODEL || 'gpt-4.1-mini',
          store: false,
          max_output_tokens: 8000,
          instructions: [
            `You translate restaurant menu texts from ${LANGUAGE_NAMES[from] || from}.`,
            'For each input item return one translation per language in its "targets" list, using the language code as "lang".',
            'Write natural, appetising menu language, not a literal word-for-word one. Keep it as short as the original.',
            'Do not translate brand names, place names or protected names (Rioja, Ribeye if the original uses it, Idiazabal…) and keep well-known dish names people recognise.',
            'Keep numbers, quantities and punctuation. Never add, explain or omit anything. Return the same "id" you were given.',
            'Kinds: category = menu section; dish = dish name; description = short dish description; course = course of a set menu; option = dish in a set menu; title/note = short heading.',
          ].join(' '),
          input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(items) }] }],
          text: { format: { type: 'json_schema', name: 'menu_translations', strict: true, schema: SCHEMA } },
        }),
      });
    } catch (err) {
      throw new TranslationError(err?.name === 'AbortError' ? 'La traducción ha tardado demasiado' : 'No se ha podido contactar con el traductor');
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new TranslationError(`El traductor ha respondido ${response.status}`);
    return JSON.parse(outputText(await response.json())).translations;
  }
}

let provider;
const current = () => provider || (provider = new OpenAITranslationProvider());

/**
 * items: [{ id, kind, text, targets: ['en','ca'] }] (texts in `from`).
 * Returns { [id]: { en: '…', ca: '…' } } with only what was asked and came back valid.
 */
async function translate({ from, items }) {
  const clean = items
    .map((i) => ({ id: String(i.id), kind: KINDS.includes(i.kind) ? i.kind : 'note', text: String(i.text || '').trim().slice(0, MAX_TEXT), targets: [...new Set((i.targets || []).filter((l) => l !== from && LANGUAGE_NAMES[l]))] }))
    .filter((i) => i.text && i.targets.length);
  const asked = new Map(clean.map((i) => [i.id, new Set(i.targets)]));
  const out = {};
  for (let at = 0; at < clean.length; at += CHUNK) {
    const result = await current().translate({ from, items: clean.slice(at, at + CHUNK) });
    for (const r of result || []) {
      const langs = asked.get(String(r?.id));
      const text = typeof r?.text === 'string' ? r.text.trim().slice(0, MAX_TEXT) : '';
      if (!langs || !langs.has(r.lang) || !text) continue;
      (out[r.id] ||= {})[r.lang] = text;
    }
  }
  return out;
}

module.exports = { translate, TranslationError, CHUNK, setProviderForTests(p) { provider = p; } };

/**
 * Calls Gemini with a prompt + base64 image and returns the text response.
 * The API key goes in a header (not the URL) so it can't end up in logs.
 * Model configurable via GEMINI_MODEL env var (default: gemini-2.5-flash).
 */
export async function callGemini(base64, prompt, mimeType = 'image/jpeg') {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY || '' },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64 } },
        ],
      }],
    }),
  });

  const d = await r.json();
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.error('❌ Gemini bad response:', JSON.stringify(d).slice(0, 500));
    throw new Error(`Gemini returned no valid text. ${d.error?.message || ''}`);
  }
  return text;
}

/** Strips JSON code-fences from a Gemini response and parses it. */
export function parseGeminiJson(text) {
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

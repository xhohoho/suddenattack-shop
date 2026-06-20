/**
 * Calls Gemini 2.5 Flash with a prompt + base64 image and returns the text response.
 */
export async function callGemini(base64, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: base64 } },
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

// Voice ranking and saved settings for "Listen to this story" (issues #118, #165).
// Pure functions only (no DOM), so scripts/test-listen.mjs can check them directly.
//
// Browsers expose nothing about voice quality except the voice's name, language and whether it is local, so the
// ranking below is a heuristic over names. Same voices in, same order out.
//
//  1. Language: only voices for the page language (English is the fallback when the device has none for it).
//  2. Quality tier, best first:
//       3  names with "Natural" or "Neural" (Edge: "Microsoft Aria Online (Natural)")
//       2  names with "Online", "Enhanced", "Premium" or "Siri", and Google's network voices ("Google US English")
//       1  everything else (for example "Samantha")
//       0  voices known to sound robotic: eSpeak, "... Desktop" (Microsoft David/Zira/Mark Desktop), "Microsoft David",
//          "Microsoft Zira", "Microsoft Mark", and the macOS novelty voices (Fred, Albert, Bad News, Bells, Boing,
//          Bubbles, Cellos, Jester, Organ, Superstar, Trinoids, Whisper, Wobble, Zarvox and the like).
//     A good keyword wins over a robotic one in the same name.
//  3. The exact locale (en-US on an en-US page; a bare "en" page counts as en-US) ahead of other regions.
//  4. A local voice is only a tie-break after all of that, never the first rule.
//  5. Last: name, then the browser's own order, so the result never depends on sort stability.

export interface VoiceLike { name: string; lang: string; localService?: boolean; default?: boolean }

export const SPEEDS = [
  { label: 'Slower', rate: 0.8 },
  { label: 'Normal', rate: 0.95 },
  { label: 'Faster', rate: 1.15 },
  { label: 'Fastest', rate: 1.3 },
] as const;
export const DEFAULT_RATE = 0.95;
export const SETTINGS_KEY = 'imc.listen.v1';
export const SAMPLE_TEXT = 'This is how stories will sound.';

const STRONG = /\b(natural|neural)\b/i;
const GOOD = /\b(online|enhanced|premium|siri)\b|^google\b/i;
const ROBOTIC = /espeak|\bdesktop\b|^microsoft (david|zira|mark)\b|^(fred|albert|bad news|bells|boing|bubbles|cellos|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|kathy|agnes|bahh|good news|hysterical|pipe organ)\b/i;

const norm = (lang: string) => String(lang || '').toLowerCase().replace(/_/g, '-');

/** 3 natural/neural, 2 other good, 1 ordinary, 0 robotic. */
export function voiceTier(name: string): number {
  if (STRONG.test(name)) return 3;
  if (GOOD.test(name)) return 2;
  if (ROBOTIC.test(name)) return 0;
  return 1;
}

/** The language prefix used for the page: its own when the device has a voice for it, English otherwise. */
export function voiceLanguage(voices: readonly VoiceLike[], lang: string): string {
  const base = norm(lang || 'en').split('-')[0] || 'en';
  return base === 'en' || !voices.some((v) => norm(v.lang).split('-')[0] === base) ? 'en' : base;
}

/** The voices for the page language, best first. Never mutates the input. */
export function rankVoices<T extends VoiceLike>(voices: readonly T[], lang: string): T[] {
  const want = voiceLanguage(voices, lang);
  const page = norm(lang || 'en');
  const wantLocale = page === 'en' ? 'en-us' : page;
  return voices
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => norm(v.lang).split('-')[0] === want)
    .sort((a, b) => {
      const ta = voiceTier(a.v.name), tb = voiceTier(b.v.name);
      if (ta !== tb) return tb - ta;
      const ea = norm(a.v.lang) === wantLocale ? 1 : 0, eb = norm(b.v.lang) === wantLocale ? 1 : 0;
      if (ea !== eb) return eb - ea;
      const la = a.v.localService ? 1 : 0, lb = b.v.localService ? 1 : 0;
      if (la !== lb) return lb - la;
      return a.v.name < b.v.name ? -1 : a.v.name > b.v.name ? 1 : a.i - b.i;
    })
    .map(({ v }) => v);
}

export interface ListenSettings { voice: string; rate: number }

/** Reads saved settings defensively: anything unknown falls back to the default (no saved voice, rate 0.95). */
export function parseSettings(raw: string | null | undefined): ListenSettings {
  const out: ListenSettings = { voice: '', rate: DEFAULT_RATE };
  try {
    const o = JSON.parse(String(raw ?? ''));
    if (o && typeof o === 'object') {
      if (typeof o.voice === 'string' && o.voice.length <= 200) out.voice = o.voice;
      if (SPEEDS.some((s) => s.rate === o.rate)) out.rate = o.rate;
    }
  } catch { /* defaults */ }
  return out;
}

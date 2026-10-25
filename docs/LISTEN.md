# Listen to this story

Story pages offer a **Listen to this story** button (issues #118 and #165). It uses the reader's own browser speech synthesis: free, private, nothing is sent anywhere, no cloud or server text-to-speech and no extra dependency. Without `speechSynthesis` the whole control (including Voice and speed) stays hidden. The print stylesheet hides it too.

## What is read
Title, summary, key points, announcement details and the body, in that order, in chunks of about 200 characters (so browsers that cut off long utterances keep going). Photo captions, credits, buttons and the share row are skipped. Pause and Resume (with a watchdog), Stop, stop on page hide and late-event guards are unchanged.

## Choosing the voice (`src/lib/listen-voices.ts`)
Browsers only expose a voice's name, language and whether it is local, so the ranking is a name heuristic. `rankVoices(voices, lang)`:

1. Keep voices for the page language (English when the device has none for it).
2. Tiers, best first: Natural or Neural (for example "Microsoft Aria Online (Natural)"); Online, Enhanced, Premium, Siri and Google's network voices ("Google US English"); everything else; known robotic voices last (eSpeak, names with "Desktop", Microsoft David, Zira and Mark, Fred, Albert, Bad News, Bells, Boing, Bubbles, Cellos, Jester, Organ, Superstar, Trinoids, Whisper, Wobble, Zarvox and similar).
3. Within a tier, the exact locale first (en-US on an en-US or bare "en" page).
4. A local voice is only a tie-break after that, never the first rule.
5. Then name, then the browser's order, so the result is deterministic.
6. Voices are identified by `voiceURI` (the name when empty). Exact duplicates are dropped after ranking; two different voices with the same name are listed as "Name" and "Name (2)".

The first voice is used by default and labelled "(recommended)". Default speed is 0.95 and pitch 1.

## Voice and speed
A native `<details>` next to the button holds a Voice select (the ranked voices), a Speed select (Slower 0.8, Normal 0.95, Faster 1.15, Fastest 1.3) and **Try voice**, which says "This is how stories will sound." (no story text). Choices are saved in this browser's `localStorage` under `imc.listen.v1` as `{"voice": voiceURI, "rate": number}` (an older saved voice name is still accepted), read defensively (an unknown voice or speed falls back to the default). Changing a setting mid-story applies from the next chunk without restarting, and never moves focus. A voice list that loads late updates the options and keeps the reader's choice; the voice in use is locked when Listen starts, so a late list never switches it mid-story (changing the Voice setting releases the lock). With no voices the list shows one "Device default voice" option.

**Try voice while a story is reading or paused** keeps the reader's place: the player is left Paused ("Playing a voice sample. Press Resume to continue the story.") at the chunk that was in progress, and Resume continues from there with the new voice and speed. While idle it just plays the sample. The summary shows a text sign (right triangle closed, down triangle open), no motion.

Test: `scripts/test-listen.mjs` (stubbed `speechSynthesis`, plus pure `rankVoices` checks).

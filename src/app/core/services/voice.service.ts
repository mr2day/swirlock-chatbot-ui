import { inject, Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { franc } from 'franc-min';
import { PersonaService } from './persona.service';

/**
 * Simplified voice flow — classical press-to-talk.
 *
 * State machine:
 *
 *   idle ──tap button──▶ recording ──silence auto-stop──▶ (submit) ──reply streams──▶ speaking
 *    ▲                       │                                                          │
 *    │                  tap to cancel                                                  TTS done
 *    └───────────────────────┴──────────────────────────────────────────────────────────┘
 *
 *   - idle: nothing happening. Big "Listen" button is visible and
 *     enabled.
 *   - recording: mic on, partialResults stream into liveTranscript
 *     so the user sees that the system hears them. Android's
 *     SpeechRecognizer auto-stops on silence; we then bump the
 *     `transcriptReady` counter and the composer submits the
 *     latest partial as the user's message. The user can also tap
 *     the button to cancel mid-recording (no submit).
 *   - speaking: assistant reply is streaming; we sentence-chunk
 *     the chunks to TextToSpeech.speak (QueueStrategy.Add) so
 *     audio plays in parallel with the text appearing in the
 *     bubble. When all chunks finish, return to idle. User must
 *     tap the button again to record the next turn — no auto-
 *     restart of the mic.
 *
 * Web build is a no-op: `native` is false; the composer's button
 * is conditional on native and doesn't render.
 *
 * Earlier (b123) version had wake-word commit + preview state.
 * Removed at the user's request: "implement it in a classical way".
 */

export type VoiceState = 'idle' | 'recording' | 'speaking';

/**
 * Default STT/TTS language used when no other signal is available
 * (new session, voice mode toggled before any text has been typed,
 * or franc can't decide from a very short input). English because
 * it's the most universally well-supported on Android engines.
 */
const DEFAULT_LANG = 'en-US';

/** localStorage key for the user's chosen STT language. */
const STT_LANG_STORAGE_KEY = 'voice.sttLang';

/** BCP 47 locale + display label for each language the composer's
 *  picker offers the user. Covers the European set Nick called out
 *  (Polish, Portuguese, Estonian, Basque, Spanish, French, English,
 *  Greek, Italian, Romanian, …) plus the common ones. The composer
 *  imports this list to render the dropdown; the VoiceService
 *  accepts any BCP 47 string so users with niche locales can still
 *  set it programmatically. */
export const VOICE_LANGUAGE_OPTIONS: ReadonlyArray<{
  code: string;
  label: string;
}> = [
  { code: 'en-US', label: 'English' },
  { code: 'ro-RO', label: 'Română' },
  { code: 'es-ES', label: 'Español' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'it-IT', label: 'Italiano' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'pt-PT', label: 'Português' },
  { code: 'pl-PL', label: 'Polski' },
  { code: 'el-GR', label: 'Ελληνικά' },
  { code: 'nl-NL', label: 'Nederlands' },
  { code: 'sv-SE', label: 'Svenska' },
  { code: 'da-DK', label: 'Dansk' },
  { code: 'nb-NO', label: 'Norsk' },
  { code: 'fi-FI', label: 'Suomi' },
  { code: 'cs-CZ', label: 'Čeština' },
  { code: 'sk-SK', label: 'Slovenčina' },
  { code: 'hu-HU', label: 'Magyar' },
  { code: 'bg-BG', label: 'Български' },
  { code: 'hr-HR', label: 'Hrvatski' },
  { code: 'sr-RS', label: 'Српски' },
  { code: 'sl-SI', label: 'Slovenščina' },
  { code: 'uk-UA', label: 'Українська' },
  { code: 'ru-RU', label: 'Русский' },
  { code: 'tr-TR', label: 'Türkçe' },
  { code: 'lt-LT', label: 'Lietuvių' },
  { code: 'lv-LV', label: 'Latviešu' },
  { code: 'et-EE', label: 'Eesti' },
  { code: 'ca-ES', label: 'Català' },
  { code: 'eu-ES', label: 'Euskara' },
  { code: 'gl-ES', label: 'Galego' },
  { code: 'cy-GB', label: 'Cymraeg' },
  { code: 'ga-IE', label: 'Gaeilge' },
  { code: 'is-IS', label: 'Íslenska' },
  { code: 'mt-MT', label: 'Malti' },
];

const SENTENCE_BOUNDARY = /[.!?\n]\s+/;
/** Minimum chars a sentence must have before we send it to the TTS
 *  engine. Used to avoid dispatching single-character utterances on
 *  punctuation false-positives ("...") but kept low so short
 *  legitimate sentences ("Hi!", "Sigur.") still dispatch promptly
 *  instead of waiting for the next boundary. */
const MIN_CHUNK_CHARS = 4;

/**
 * ISO 639-3 (what franc returns) → BCP 47 (what Android's TTS and
 * SpeechRecognizer want). Covers the European set the user listed
 * plus the common world languages a multilingual user might pull
 * in. Defaulting to en-US for anything not in this map is fine —
 * the user can still type that language and the LLM will reply in
 * it; voice I/O just falls back to English for unknown locales.
 */
const ISO_639_3_TO_BCP_47: Record<string, string> = {
  eng: 'en-US',
  ron: 'ro-RO',
  pol: 'pl-PL',
  por: 'pt-PT',
  spa: 'es-ES',
  fra: 'fr-FR',
  ita: 'it-IT',
  deu: 'de-DE',
  nld: 'nl-NL',
  ell: 'el-GR',
  est: 'et-EE',
  fin: 'fi-FI',
  swe: 'sv-SE',
  nor: 'nb-NO',
  dan: 'da-DK',
  ces: 'cs-CZ',
  slk: 'sk-SK',
  hun: 'hu-HU',
  bul: 'bg-BG',
  hrv: 'hr-HR',
  srp: 'sr-RS',
  slv: 'sl-SI',
  ukr: 'uk-UA',
  rus: 'ru-RU',
  tur: 'tr-TR',
  lit: 'lt-LT',
  lav: 'lv-LV',
  cat: 'ca-ES',
  eus: 'eu-ES',
  glg: 'gl-ES',
  cym: 'cy-GB',
  gle: 'ga-IE',
  isl: 'is-IS',
  mlt: 'mt-MT',
};

/**
 * Per-turn language detector. franc-min is statistically reliable
 * on ~100+ char text but routinely confuses Romance languages
 * (en/pt/es/it/ro share enough short function words that a 30-char
 * English greeting can come back as Portuguese). To avoid that
 * class of bug we:
 *
 *  - For text < 80 chars: trust `fallback` (the user's own
 *    sttLang from their latest typed/spoken message). The user's
 *    own language is a far better prior than a short-text franc
 *    guess.
 *  - For text >= 80 chars: accept franc's verdict only if it maps
 *    to a known BCP 47 locale; otherwise stick with fallback.
 *
 * Net result: short replies inherit the user's language; long
 * replies in a different language (e.g. the bot answers in French
 * because the user asked for a translation) are still detected
 * correctly.
 */
function detectLang(text: string, fallback: string = DEFAULT_LANG): string {
  if (!text || text.trim().length < 10) return fallback;
  // For short text franc is too noisy; trust the user's own language.
  if (text.length < 80) return fallback;
  try {
    const iso = franc(text, { minLength: 20 });
    if (iso === 'und') return fallback;
    return ISO_639_3_TO_BCP_47[iso] ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Strips markdown formatting characters from a fragment of assistant
 * text before it reaches the TTS engine. Without this, the engine
 * reads `**bold**` as "asterisk asterisk bold asterisk asterisk",
 * code fences as "backtick backtick backtick", and so on — produced
 * an unusable spoken output on assistant replies that use any
 * formatting at all.
 *
 * Deliberately a regex stripper, not a full markdown parser: TTS
 * only needs the prose, not structure. Spec-compliance isn't the
 * goal — making the audio listenable is.
 */
function stripMarkdownForTTS(text: string): string {
  let t = text;
  // Images: drop entirely (alt text isn't meant to be spoken).
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // Links: keep the link text, drop the URL.
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Triple-emphasis ***x*** / ___x___.
  t = t.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '$1');
  t = t.replace(/___([\s\S]+?)___/g, '$1');
  // Bold **x** / __x__.
  t = t.replace(/\*\*([\s\S]+?)\*\*/g, '$1');
  t = t.replace(/__([\s\S]+?)__/g, '$1');
  // Italic *x* / _x_. (Lone single-char wrappers; greedy variants
  // would over-match across paragraphs.)
  t = t.replace(/\*([^*\n]+?)\*/g, '$1');
  t = t.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1$2');
  // Inline code `x`.
  t = t.replace(/`([^`\n]+)`/g, '$1');
  // Code fences — drop the fence lines; keep the inner content
  // because comments and identifiers often hold the actual sentence.
  t = t.replace(/^[ \t]*```[a-zA-Z0-9_+\-]*\s*$/gm, '');
  // Headings: strip leading #'s.
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  // Blockquotes: strip leading >.
  t = t.replace(/^\s{0,3}>\s+/gm, '');
  // Unordered list markers (-, *, +) at line start.
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  // Ordered list markers (1.) at line start.
  t = t.replace(/^\s*\d+\.\s+/gm, '');
  // Horizontal rules.
  t = t.replace(/^\s*-{3,}\s*$/gm, '');
  // Table cell separators.
  t = t.replace(/\|/g, ' ');
  // Stray decoration that survived: lone asterisks and trailing
  // underscores that weren't paired. TTS never wants them.
  t = t.replace(/[*]+/g, '');
  // HTML entities (the assistant occasionally emits these).
  t = t
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Collapse runs of whitespace.
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

interface SpeechRecognitionLike {
  available(): Promise<{ available: boolean }>;
  start(opts: {
    language?: string;
    maxResults?: number;
    partialResults?: boolean;
    popup?: boolean;
  }): Promise<unknown>;
  stop(): Promise<void>;
  checkPermissions(): Promise<{ speechRecognition: string }>;
  requestPermissions(): Promise<{ speechRecognition: string }>;
  addListener(
    eventName: 'partialResults' | 'listeningState',
    fn: (data: { matches?: string[]; status?: string }) => void,
  ): Promise<{ remove: () => void }>;
  removeAllListeners(): Promise<void>;
}

interface TtsVoice {
  voiceURI?: string;
  name?: string;
  lang?: string;
  default?: boolean;
  localService?: boolean;
}

interface TextToSpeechLike {
  speak(opts: {
    text: string;
    lang?: string;
    rate?: number;
    pitch?: number;
    volume?: number;
    voice?: number;
    queueStrategy?: number;
  }): Promise<void>;
  stop(): Promise<void>;
  getSupportedVoices(): Promise<{ voices: TtsVoice[] }>;
}

@Injectable({ providedIn: 'root' })
export class VoiceService {
  constructor() {
    this.loadPersistedLanguage();
  }

  readonly native = signal<boolean>(Capacitor.isNativePlatform());
  readonly state = signal<VoiceState>('idle');
  readonly liveTranscript = signal<string>('');
  readonly error = signal<string | null>(null);

  /** Bumped each time silence-auto-stop produced a non-empty
   *  transcript ready to submit. Composer watches this counter and
   *  reads `lastTranscript` once per increment. */
  readonly transcriptReady = signal<number>(0);

  private _lastTranscript = '';
  get lastTranscript(): string {
    return this._lastTranscript;
  }

  private stt: SpeechRecognitionLike | null = null;
  private tts: TextToSpeechLike | null = null;
  private partialListener: { remove: () => void } | null = null;
  private stateListener: { remove: () => void } | null = null;
  private currentPartial = '';
  private ttsBuffer = '';
  private activeSpeakCount = 0;
  /** Chain of in-flight speak() calls. Each new dispatchSpeak
   *  appends to the chain so the next call only starts after the
   *  previous one fully resolves. Without this, fire-and-forget
   *  speak() calls relied on the plugin's QueueStrategy.Add to
   *  serialize them — which on some Android engines glitches mid-
   *  response (the voice cuts to a different variant or pitches
   *  weirdly between sentences). */
  private speakChain: Promise<unknown> = Promise.resolve();
  /** Language used when the next startRecording fires. Persisted
   *  to localStorage so the user's pick survives reloads. Updated
   *  by noteUserText (franc-detected from typed text) or by the
   *  composer's manual language picker (setLanguage). Android
   *  can't change recognizer language mid-session, so this only
   *  takes effect on the next mic press. */
  readonly sttLang = signal<string>(DEFAULT_LANG);
  /** Language locked in for the current TTS response. Detected from
   *  the first 80 chars of the response stream and reused for every
   *  sentence chunk so we don't switch voices mid-paragraph. */
  private ttsLang: string = DEFAULT_LANG;
  private ttsLangLocked = false;
  /** Resolved voice index for the current TTS response. Picked once
   *  per response based on persona gender + detected language. */
  private ttsVoiceIndex: number | undefined = undefined;
  /** Cached voice list from the plugin — populated lazily on first
   *  TTS use; voice metadata doesn't change at runtime. */
  private cachedVoices: TtsVoice[] | null = null;

  private readonly personas = inject(PersonaService);

  /** Lazy plugin import. Returns false on web. */
  private async ensurePlugins(): Promise<boolean> {
    if (!this.native()) return false;
    if (this.stt && this.tts) return true;
    try {
      const sttMod = await import('@capacitor-community/speech-recognition');
      const ttsMod = await import('@capacitor-community/text-to-speech');
      this.stt = sttMod.SpeechRecognition as unknown as SpeechRecognitionLike;
      this.tts = ttsMod.TextToSpeech as unknown as TextToSpeechLike;
      return true;
    } catch (err) {
      console.error('[voice] plugin import failed', err);
      this.error.set('Voice plugins unavailable on this device.');
      return false;
    }
  }

  /** Single user-facing toggle. Tap the big mic button → calls this.
   *
   *  - idle → start recording (after permission grant).
   *  - recording → cancel (no submit).
   *  - speaking → stop TTS.
   */
  async toggle(): Promise<void> {
    switch (this.state()) {
      case 'idle':
        await this.startRecording();
        break;
      case 'recording':
        await this.cancelRecording();
        break;
      case 'speaking':
        await this.stopSpeaking();
        break;
    }
  }

  private async startRecording(): Promise<void> {
    if (!(await this.ensurePlugins())) return;
    const stt = this.stt!;
    try {
      const avail = await stt.available();
      if (!avail.available) {
        this.error.set('Speech recognition is not available on this device.');
        return;
      }
      let perm = await stt.checkPermissions();
      if (perm.speechRecognition !== 'granted') {
        perm = await stt.requestPermissions();
      }
      if (perm.speechRecognition !== 'granted') {
        this.error.set('Microphone permission was denied.');
        return;
      }
      await this.attachListeners();
      this.currentPartial = '';
      this.liveTranscript.set('');
      this.error.set(null);
      this.state.set('recording');
      // Fire-and-forget. The Android SpeechRecognizer auto-stops on
      // silence; the listeningState='stopped' listener will then
      // finalize the transcript and bump transcriptReady. Language
      // is whatever was last detected from the user's text (set via
      // noteUserText) or DEFAULT_LANG for a fresh session.
      void stt.start({
        language: this.sttLang(),
        maxResults: 1,
        partialResults: true,
        popup: false,
      });
    } catch (err) {
      console.error('[voice] startRecording failed', err);
      this.error.set(this.errorMessage(err));
      this.state.set('idle');
    }
  }

  /** User-initiated cancel — discard the transcript, no submit. */
  private async cancelRecording(): Promise<void> {
    if (!this.stt) return;
    // Set a flag the listeningState listener can read to know this
    // was a manual cancel, not a natural auto-stop. We use the state
    // transition itself: flipping to 'idle' before stop() is called
    // tells onListeningState to skip the submit branch.
    this.state.set('idle');
    this.currentPartial = '';
    this.liveTranscript.set('');
    try {
      await this.stt.stop();
    } catch {
      /* harmless */
    }
  }

  private async attachListeners(): Promise<void> {
    if (!this.stt) return;
    if (this.partialListener && this.stateListener) return;
    this.partialListener = await this.stt.addListener(
      'partialResults',
      (data) => this.onPartial(data.matches ?? []),
    );
    this.stateListener = await this.stt.addListener(
      'listeningState',
      (data) => this.onListeningState(data.status ?? ''),
    );
  }

  private onPartial(matches: string[]): void {
    if (this.state() !== 'recording') return;
    const text = matches[0]?.trim() ?? '';
    this.currentPartial = text;
    this.liveTranscript.set(text);
  }

  /** Silence-auto-stop fired. Android's SpeechRecognizer calls
   *  onEndOfSpeech() BEFORE onResults() — and the plugin maps
   *  onEndOfSpeech to listeningState='stopped' while emitting the
   *  final transcription via a late partialResults event. If we
   *  consume currentPartial the instant we see stopped, we lose
   *  whatever word(s) were still in onResults's pipeline.
   *
   *  So we wait ~400ms in 'recording' state for any late partial
   *  to update currentPartial, then commit. The state stays
   *  'recording' during the delay so onPartial keeps accepting
   *  updates. If the user cancelled mid-delay, state will already
   *  have flipped to 'idle' and we abort. */
  private onListeningState(status: string): void {
    if (status !== 'stopped') return;
    if (this.state() !== 'recording') return;
    setTimeout(() => this.finalizeRecording(), 400);
  }

  private finalizeRecording(): void {
    if (this.state() !== 'recording') return;
    const text = this.currentPartial.trim();
    this.currentPartial = '';
    this.liveTranscript.set('');
    this.state.set('idle');
    if (text) {
      this._lastTranscript = text;
      this.transcriptReady.update((n) => n + 1);
    }
  }

  /** Called by the composer right before submitting a turn that came
   *  out of voice mode. Prepares the TTS pipeline; the chat-page
   *  feeds chunks into speakChunk while the assistant streams. */
  async beforeSpeakReply(): Promise<void> {
    if (!this.tts) return;
    // If recording was somehow still active, stop it cleanly.
    if (this.state() === 'recording' && this.stt) {
      try {
        await this.stt.stop();
      } catch {
        /* */
      }
    }
    this.ttsBuffer = '';
    this.activeSpeakCount = 0;
    this.ttsLangLocked = false;
    this.ttsLang = DEFAULT_LANG;
    this.ttsVoiceIndex = undefined;
    this.state.set('speaking');
  }

  /** Composer calls this whenever the user types text or sends a
   *  message. We run franc on the text directly (aggressive — not
   *  the TTS-friendly detectLang with its short-text fallback) and
   *  update sttLang when franc returns a confident verdict. Even a
   *  ~15-char message in a different language can switch the
   *  recognizer, so the user doesn't have to type a full paragraph
   *  to get STT to follow. */
  noteUserText(text: string): void {
    if (!text || text.trim().length < 5) return;
    try {
      const iso = franc(text, { minLength: 5 });
      if (iso === 'und') return;
      const mapped = ISO_639_3_TO_BCP_47[iso];
      if (mapped && mapped !== this.sttLang()) {
        this.setLanguage(mapped);
        console.log(
          `[voice] stt-lang auto-switched to ${mapped} from typed text`,
        );
      }
    } catch {
      /* keep current */
    }
  }

  /** Manual language override from the composer's picker. Persisted
   *  so the user's choice survives app reloads. */
  setLanguage(lang: string): void {
    if (!lang || lang === this.sttLang()) return;
    this.sttLang.set(lang);
    try {
      localStorage.setItem(STT_LANG_STORAGE_KEY, lang);
    } catch {
      /* localStorage unavailable; in-memory only */
    }
  }

  /** Reads the persisted STT language at construction time so the
   *  user's last choice survives reloads. Called from the
   *  constructor; safe to call repeatedly. */
  private loadPersistedLanguage(): void {
    try {
      const saved = localStorage.getItem(STT_LANG_STORAGE_KEY);
      if (saved) this.sttLang.set(saved);
    } catch {
      /* no-op */
    }
  }

  /** Streaming-TTS chunk. Composer calls this for every assistant
   *  chunk while state is 'speaking'. The lock fires inside
   *  drainSentences, right before the very first dispatch — by
   *  then we have at least one complete sentence in the buffer,
   *  which is enough context for the language detector AND
   *  guarantees every sentence in the response uses the same
   *  locked voice. */
  async speakChunk(chunk: string): Promise<void> {
    if (this.state() !== 'speaking') return;
    if (!this.tts) return;
    this.ttsBuffer += chunk;
    await this.drainSentences(false);
  }

  /** Locks the response's language + gender-matched voice. Called
   *  before any dispatch fires; ensures every sentence in the
   *  response uses the same voice. Uses the user's own sttLang as
   *  the fallback when detection isn't confident — far more
   *  reliable than a short-text franc guess. */
  private async lockTtsLang(): Promise<void> {
    if (this.ttsLangLocked) return;
    this.ttsLang = detectLang(this.ttsBuffer, this.sttLang());
    this.ttsVoiceIndex = await this.pickVoiceIndex(this.ttsLang);
    this.ttsLangLocked = true;
    console.log(
      `[voice] tts-lang locked: lang=${this.ttsLang} voice-index=${this.ttsVoiceIndex ?? '(engine default)'} buffer.length=${this.ttsBuffer.length}`,
    );
  }

  /** End of stream: flush any remaining buffer, await all queued
   *  speech, then return to 'idle'. User taps the button to record
   *  the next turn — no auto-restart. */
  async finalizeReply(): Promise<void> {
    if (this.state() !== 'speaking') return;
    if (!this.tts) return;
    if (!this.ttsLangLocked) await this.lockTtsLang();
    await this.drainSentences(true);
    while (this.activeSpeakCount > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.state.set('idle');
  }

  /** User tapped the mic while TTS was playing — stop the queue. */
  private async stopSpeaking(): Promise<void> {
    if (!this.tts) return;
    try {
      await this.tts.stop();
    } catch {
      /* */
    }
    this.ttsBuffer = '';
    this.activeSpeakCount = 0;
    this.state.set('idle');
  }

  private async drainSentences(forceFlush: boolean): Promise<void> {
    if (!this.tts) return;
    while (this.ttsBuffer.length > 0) {
      const match = this.ttsBuffer.match(SENTENCE_BOUNDARY);
      if (!match) {
        if (forceFlush && this.ttsBuffer.trim().length > 0) {
          if (!this.ttsLangLocked) await this.lockTtsLang();
          this.dispatchSpeak(this.ttsBuffer.trim());
          this.ttsBuffer = '';
        }
        return;
      }
      const cutAt = (match.index ?? 0) + match[0].length;
      const piece = this.ttsBuffer.slice(0, cutAt).trim();
      const remainder = this.ttsBuffer.slice(cutAt);
      if (piece.length < MIN_CHUNK_CHARS && !forceFlush) {
        return;
      }
      // Lock BEFORE the very first dispatch so the entire response
      // uses a single, consistent voice.
      if (!this.ttsLangLocked) await this.lockTtsLang();
      this.dispatchSpeak(piece);
      this.ttsBuffer = remainder;
    }
  }

  private dispatchSpeak(text: string): void {
    if (!this.tts) return;
    // Strip markdown formatting so the TTS engine doesn't read
    // asterisks, backticks, list markers, etc. as literal words.
    const spoken = stripMarkdownForTTS(text);
    if (!spoken) return;
    this.activeSpeakCount += 1;
    const opts: Parameters<TextToSpeechLike['speak']>[0] = {
      text: spoken,
      lang: this.ttsLang,
      queueStrategy: 1 /* Add */,
    };
    if (this.ttsVoiceIndex !== undefined) opts.voice = this.ttsVoiceIndex;
    // Serialize through speakChain: each speak() awaits the prior
    // one. Guarantees the voice setting doesn't change mid-response.
    this.speakChain = this.speakChain
      .catch(() => {
        /* swallow the previous one's error; we already logged it */
      })
      .then(() => this.tts!.speak(opts))
      .catch((err) => console.error('[voice] speak failed', err))
      .finally(() => {
        this.activeSpeakCount = Math.max(0, this.activeSpeakCount - 1);
      });
  }

  /** Heuristic gender classifier for a TTS voice name. Returns
   *  'male' / 'female' / null. The 'null' case is important: it
   *  means we couldn't confidently identify the voice's gender, in
   *  which case the picker prefers to NOT pass a voice index at all
   *  and let the engine use its own default for the language (the
   *  worst case is no gender match, never a wrong-gender match). */
  private voiceGender(name: string): 'male' | 'female' | null {
    const n = name.toLowerCase();
    // Google TTS internal IDs: "xx-XX-x-IOL-local" etc. The 4th
    // segment carries Google's variant code. Empirically observed:
    //   iol / ios / iog / iof / ioa  → female
    //   iom / iod / ioe / iob / ioc  → male
    // Variants with 'h' or 'k' suffix are usually higher-quality
    // local-only versions of the same gendered voice.
    const googleMatch = n.match(/-x-(io[a-z])(?:-|$)/);
    if (googleMatch) {
      const code = googleMatch[1];
      if (['iol', 'ios', 'iog', 'iof', 'ioa', 'ioh', 'iok'].includes(code)) {
        return 'female';
      }
      if (['iom', 'iod', 'ioe', 'iob', 'ioc'].includes(code)) {
        return 'male';
      }
    }
    // Explicit gender words in the name.
    if (/\bfemale\b|\bfeminin/.test(n)) return 'female';
    if (/\bmale\b|\bmascul/.test(n)) return 'male';
    // Common Western female / male first names that Apple/Samsung/etc.
    // sometimes use as voice display names.
    const femaleNames = [
      'samantha', 'karen', 'tessa', 'moira', 'allison', 'susan',
      'maria', 'anna', 'sofia', 'monica', 'celine', 'audrey', 'amelie',
      'ioana', 'natalia', 'paulina', 'agata', 'martina', 'giulia',
      'laila', 'amalia', 'elena', 'monika', 'kalliope', 'satu',
    ];
    const maleNames = [
      'daniel', 'alex', 'tom', 'fred', 'james', 'peter', 'paul',
      'mark', 'george', 'mateo', 'jorge', 'andre', 'francesco', 'pietro',
      'andrei', 'jacek', 'krzysztof', 'kostas', 'mikko', 'henrik',
      'aleksander', 'ivan', 'dimitri',
    ];
    if (femaleNames.some((nm) => n.includes(nm))) return 'female';
    if (maleNames.some((nm) => n.includes(nm))) return 'male';
    return null;
  }

  /** Returns the index (in TextToSpeech.getSupportedVoices output) of
   *  the best voice for the given BCP 47 language tag, matching the
   *  active persona's gender. Returns undefined if no voice can be
   *  confidently matched — caller then omits the voice param so the
   *  engine uses its own default voice for that language (which is
   *  always usable, even if its gender doesn't match the persona).
   *  This avoids the catastrophic case of picking a confidently-wrong
   *  voice. */
  private async pickVoiceIndex(lang: string): Promise<number | undefined> {
    if (!this.tts) return undefined;
    if (!this.cachedVoices) {
      try {
        const result = await this.tts.getSupportedVoices();
        this.cachedVoices = result?.voices ?? [];
        // Log once so we can audit what the device reports and tune
        // the heuristic when a new device or engine appears.
        console.log(
          '[voice] available voices:',
          this.cachedVoices.map((v) => ({ name: v.name, lang: v.lang })),
        );
      } catch {
        this.cachedVoices = [];
      }
    }
    if (this.cachedVoices.length === 0) return undefined;

    const wantedGender = this.personas.active().gender;
    const langPrefix = lang.toLowerCase().slice(0, 2);
    const matching = this.cachedVoices
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => (v.lang ?? '').toLowerCase().startsWith(langPrefix));
    if (matching.length === 0) return undefined;

    const classified = matching.map(({ v, i }) => ({
      v,
      i,
      g: this.voiceGender(v.name ?? ''),
    }));

    // Prefer a confidently-gendered match for the wanted gender.
    // Within that, prefer local (offline) voices, then higher-index
    // voices (Google often puts higher-quality variants later).
    const wantedMatches = classified.filter((x) => x.g === wantedGender);
    if (wantedMatches.length > 0) {
      const local = wantedMatches.find((x) => x.v.localService);
      return (local ?? wantedMatches[0]).i;
    }

    // No confident gender match → let the engine pick. The engine's
    // default voice is generally a sensible choice; better than
    // forcing a possibly-wrong-gender voice.
    return undefined;
  }

  /** Hard stop — used on session changes or if anything goes wrong. */
  async shutdown(): Promise<void> {
    if (this.stt) {
      try {
        await this.stt.stop();
      } catch {
        /* */
      }
    }
    if (this.tts) {
      try {
        await this.tts.stop();
      } catch {
        /* */
      }
    }
    if (this.partialListener || this.stateListener) {
      await this.stt?.removeAllListeners();
      this.partialListener = null;
      this.stateListener = null;
    }
    this.ttsBuffer = '';
    this.activeSpeakCount = 0;
    this.currentPartial = '';
    this.liveTranscript.set('');
    this.state.set('idle');
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}

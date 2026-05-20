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

const SENTENCE_BOUNDARY = /[.!?\n]\s+/;
const MIN_CHUNK_CHARS = 20;

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
 * Per-turn language detector. Runs franc-min over the text and
 * maps the ISO 639-3 result to BCP 47. franc needs ~10+ chars to
 * be useful; for very short inputs we fall back to DEFAULT_LANG
 * (the user can still type in their language; the next turn with
 * enough text will detect correctly). Not Romanian-biased, not
 * tied to any single user's language profile.
 */
function detectLang(text: string): string {
  if (!text || text.trim().length < 10) return DEFAULT_LANG;
  try {
    const iso = franc(text, { minLength: 8 });
    if (iso === 'und') return DEFAULT_LANG;
    return ISO_639_3_TO_BCP_47[iso] ?? DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
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
  /** Language to use when next startRecording fires. Set by
   *  noteUserText whenever the user types or sends. Android can't
   *  change the recognizer language mid-session, so this only
   *  affects future startRecording calls. */
  private sttLang: string = DEFAULT_LANG;
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
        language: this.sttLang,
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

  /** Silence-auto-stop fired. If we're still in 'recording' state,
   *  the latest partial is the user's final utterance — bump
   *  transcriptReady so the composer can submit. If state is
   *  already 'idle' (because cancelRecording was called) we drop
   *  the transcript silently. */
  private onListeningState(status: string): void {
    if (status !== 'stopped') return;
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
   *  message. We update the language to use on the next mic activation
   *  so the recognizer matches the conversation's current language. */
  noteUserText(text: string): void {
    if (!text || text.length < 4) return;
    this.sttLang = detectLang(text);
  }

  /** Streaming-TTS chunk. Composer calls this for every assistant
   *  chunk while state is 'speaking'. Sentence-buffer + queue.
   *  Detects the response language from the first ~80 chars and
   *  locks it (plus a gender-matched voice for the active persona)
   *  so we don't switch voices mid-paragraph. */
  async speakChunk(chunk: string): Promise<void> {
    if (this.state() !== 'speaking') return;
    if (!this.tts) return;
    this.ttsBuffer += chunk;
    if (!this.ttsLangLocked && this.ttsBuffer.length >= 80) {
      this.ttsLang = detectLang(this.ttsBuffer);
      this.ttsVoiceIndex = await this.pickVoiceIndex(this.ttsLang);
      this.ttsLangLocked = true;
    }
    await this.drainSentences(false);
  }

  /** End of stream: flush any remaining buffer, await all queued
   *  speech, then return to 'idle'. User taps the button to record
   *  the next turn — no auto-restart. */
  async finalizeReply(): Promise<void> {
    if (this.state() !== 'speaking') return;
    if (!this.tts) return;
    // If we never accumulated enough to lock a language, finalize
    // the detection now from whatever we have.
    if (!this.ttsLangLocked) {
      this.ttsLang = detectLang(this.ttsBuffer);
      this.ttsVoiceIndex = await this.pickVoiceIndex(this.ttsLang);
      this.ttsLangLocked = true;
    }
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
    void this.tts
      .speak(opts)
      .catch((err) => console.error('[voice] speak failed', err))
      .finally(() => {
        this.activeSpeakCount = Math.max(0, this.activeSpeakCount - 1);
      });
  }

  /** Returns the index (in TextToSpeech.getSupportedVoices output) of
   *  the best voice for the given BCP 47 language tag, matching the
   *  active persona's gender when possible. Best-effort heuristic by
   *  voice name — Android TTS voices don't carry explicit gender
   *  metadata, so we match against common gendered-name patterns. */
  private async pickVoiceIndex(lang: string): Promise<number | undefined> {
    if (!this.tts) return undefined;
    if (!this.cachedVoices) {
      try {
        const result = await this.tts.getSupportedVoices();
        this.cachedVoices = result?.voices ?? [];
      } catch {
        this.cachedVoices = [];
      }
    }
    if (this.cachedVoices.length === 0) return undefined;

    const gender = this.personas.active().gender;
    const langPrefix = lang.toLowerCase().slice(0, 2);
    const matching = this.cachedVoices
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => (v.lang ?? '').toLowerCase().startsWith(langPrefix));
    if (matching.length === 0) return undefined;

    const femaleHints = [
      'female', 'femin', 'femme', 'f-', '-f ',
      'samantha', 'karen', 'tessa', 'moira', 'allison', 'susan',
      'maria', 'anna', 'sofia', 'monica', 'celine', 'audrey', 'amelie',
      'ioana', 'natalia', 'paulina', 'agata', 'martina', 'giulia',
    ];
    const maleHints = [
      'male', 'mascul', 'm-', '-m ',
      'daniel', 'alex', 'tom', 'fred', 'james', 'peter', 'paul',
      'mark', 'george', 'mateo', 'jorge', 'andre', 'francesco', 'pietro',
      'andrei', 'jacek', 'krzysztof', 'kostas',
    ];
    const wanted = gender === 'female' ? femaleHints : maleHints;
    const opposite = gender === 'female' ? maleHints : femaleHints;

    const wantedMatch = matching.find(({ v }) =>
      wanted.some((h) => (v.name ?? '').toLowerCase().includes(h)),
    );
    if (wantedMatch) return wantedMatch.i;

    const nonOpposite = matching.find(
      ({ v }) =>
        !opposite.some((h) => (v.name ?? '').toLowerCase().includes(h)),
    );
    if (nonOpposite) return nonOpposite.i;

    return matching[0].i;
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

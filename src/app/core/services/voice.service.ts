import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

/**
 * Voice flow for the Android APK. Native-only — no-op on web.
 *
 * Wraps two Capacitor Community plugins:
 *   - @capacitor-community/speech-recognition (Android's SpeechRecognizer)
 *   - @capacitor-community/text-to-speech (Android's TextToSpeech)
 *
 * State machine:
 *
 *   off ──tap mic──▶ listening ──"show preview"──▶ preview
 *    ▲                  │                            │
 *    │           assistant reply                    "send"
 *    │                  ▼                            │
 *    └────────── speaking ◀───────────────────────── ▼
 *                                                (composer.send)
 *
 *   - off: voice mode disabled. Composer behaves as a text-only chat.
 *   - listening: mic on, partialResults stream into `liveTranscript`,
 *     regex-watched for the preview wake-word.
 *   - preview: previewText is committed; mic stays on but only
 *     watches for the send wake-word, ignoring anything else so the
 *     user can edit/think aloud without firing a send.
 *   - speaking: TTS is playing the assistant reply; mic is off
 *     (would pick up Gigi's own voice otherwise). When TTS finishes
 *     we auto-flip back to 'listening' so a vocal conversation
 *     doesn't need a tap between every turn.
 *
 * SpeechRecognizer auto-stops after 5-10s of silence. The
 * listeningState='stopped' event triggers an automatic restart as
 * long as the state is still 'listening' or 'preview'.
 */

export type VoiceState = 'off' | 'listening' | 'preview' | 'speaking';

const STT_LANG = 'ro-RO';
const TTS_LANG = 'ro-RO';

/** Bilingual wake-words. Substring match on the most recent partial
 *  result, case-insensitive. Kept reasonably long to avoid firing
 *  from incidental mid-sentence occurrence. */
const PREVIEW_WAKE = /\b(show preview|arat[aă] previzualizare|previzualizare)\b/iu;
const SEND_WAKE = /\b(send message|send it|trimite mesajul|trimite)\b/iu;

/** Sentence-ender for streaming TTS chunking. */
const SENTENCE_BOUNDARY = /[.!?\n]\s+/;
const MIN_CHUNK_CHARS = 20;

interface SpeechRecognitionLike {
  available(): Promise<{ available: boolean }>;
  start(opts: {
    language?: string;
    maxResults?: number;
    partialResults?: boolean;
    popup?: boolean;
  }): Promise<unknown>;
  stop(): Promise<void>;
  isListening(): Promise<{ listening: boolean }>;
  checkPermissions(): Promise<{ speechRecognition: string }>;
  requestPermissions(): Promise<{ speechRecognition: string }>;
  addListener(
    eventName: 'partialResults' | 'listeningState',
    fn: (data: { matches?: string[]; status?: string }) => void,
  ): Promise<{ remove: () => void }>;
  removeAllListeners(): Promise<void>;
}

interface TextToSpeechLike {
  speak(opts: {
    text: string;
    lang?: string;
    rate?: number;
    pitch?: number;
    volume?: number;
    queueStrategy?: number;
  }): Promise<void>;
  stop(): Promise<void>;
  isLanguageSupported(opts: { lang: string }): Promise<{ supported: boolean }>;
}

@Injectable({ providedIn: 'root' })
export class VoiceService {
  readonly native = signal<boolean>(Capacitor.isNativePlatform());
  readonly state = signal<VoiceState>('off');
  readonly liveTranscript = signal<string>('');
  readonly previewText = signal<string>('');
  readonly error = signal<string | null>(null);

  /** Set by the consumer (Composer) when the preview wake-word fires.
   *  Composer reads `previewText` and pushes it into the textarea. */
  readonly previewReady = signal<number>(0);
  /** Bumped when the "send" wake-word fires while in preview state.
   *  Composer watches this counter and submits when it changes. */
  readonly sendRequested = signal<number>(0);

  private stt: SpeechRecognitionLike | null = null;
  private tts: TextToSpeechLike | null = null;
  private partialListener: { remove: () => void } | null = null;
  private listeningListener: { remove: () => void } | null = null;
  private ttsBuffer = '';
  private activeSpeakCount = 0;
  private streamDone = false;

  /** Lazy import of the plugins. Returns false on web (plugins not
   *  bundled) so callers can no-op silently. */
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

  /** User-facing toggle. Tapping the mic in the composer calls this.
   *  off → listening (after permission grant). Any other state → off. */
  async toggle(): Promise<void> {
    if (this.state() === 'off') {
      await this.startListening();
    } else {
      await this.shutdown();
    }
  }

  /** Permission check + start. Idempotent — safe to call from
   *  multiple code paths. */
  private async startListening(): Promise<void> {
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
      this.error.set(null);
      this.liveTranscript.set('');
      this.previewText.set('');
      this.state.set('listening');
      await this.startUnderlyingRecognizer();
    } catch (err) {
      console.error('[voice] startListening failed', err);
      this.error.set(this.errorMessage(err));
      this.state.set('off');
    }
  }

  /** Kicks off the underlying SpeechRecognizer session. The plugin's
   *  session ends after ~5-10s of silence; the listeningState
   *  listener restarts us if state is still active. */
  private async startUnderlyingRecognizer(): Promise<void> {
    if (!this.stt) return;
    try {
      void this.stt.start({
        language: STT_LANG,
        maxResults: 1,
        partialResults: true,
        popup: false,
      });
    } catch (err) {
      console.error('[voice] underlying start failed', err);
    }
  }

  private async attachListeners(): Promise<void> {
    if (!this.stt) return;
    if (this.partialListener && this.listeningListener) return;
    this.partialListener = await this.stt.addListener(
      'partialResults',
      (data) => this.onPartial(data.matches ?? []),
    );
    this.listeningListener = await this.stt.addListener(
      'listeningState',
      (data) => this.onListeningState(data.status ?? ''),
    );
  }

  private async detachListeners(): Promise<void> {
    if (!this.stt) return;
    await this.stt.removeAllListeners();
    this.partialListener = null;
    this.listeningListener = null;
  }

  private onPartial(matches: string[]): void {
    const text = (matches[0] ?? '').trim();
    if (!text) return;

    if (this.state() === 'listening') {
      this.liveTranscript.set(text);
      if (PREVIEW_WAKE.test(text)) {
        // Strip the wake-phrase so the previewed text doesn't end
        // with "show preview"; everything before the match is the
        // user's message.
        const trimmed = text.replace(PREVIEW_WAKE, '').replace(/\s+/g, ' ').trim();
        this.previewText.set(trimmed);
        this.previewReady.update((n) => n + 1);
        this.state.set('preview');
        // Mic stays on, but onPartial below ignores everything that
        // is not the send wake-phrase.
      }
      return;
    }

    if (this.state() === 'preview') {
      if (SEND_WAKE.test(text)) {
        this.sendRequested.update((n) => n + 1);
        // After fire-and-forget, the composer flips state via
        // beforeSpeakReply when the assistant starts answering, OR
        // we just go back to listening for the next turn if the
        // composer didn't pick this up.
      }
    }
  }

  private onListeningState(status: string): void {
    if (status !== 'stopped') return;
    // Auto-restart if we're still in an active state — the plugin's
    // session ends after silence; we silently respawn it.
    if (this.state() === 'listening' || this.state() === 'preview') {
      void this.startUnderlyingRecognizer();
    }
  }

  /** Called by the composer right before it submits a turn that came
   *  from voice (whether via the "send" wake-word or a manual click
   *  while voice mode was on). Stops the mic so it doesn't catch
   *  Gigi's TTS reply, and pre-emptively flips state to 'speaking'. */
  async beforeSpeakReply(): Promise<void> {
    if (this.state() === 'off') return;
    if (!this.stt) return;
    try {
      await this.stt.stop();
    } catch {
      /* harmless */
    }
    this.state.set('speaking');
    this.ttsBuffer = '';
    this.activeSpeakCount = 0;
    this.streamDone = false;
  }

  /** Streaming-TTS chunk. Composer calls this on every chunk the
   *  assistant emits. We accumulate until a sentence boundary +
   *  minimum length, then flush to the TTS queue. */
  async speakChunk(chunk: string): Promise<void> {
    if (this.state() !== 'speaking') return;
    if (!this.tts) return;
    this.ttsBuffer += chunk;
    await this.drainSentences(false);
  }

  /** End of stream: flush any remaining buffer to TTS, await all
   *  queued speech, then transition back to 'listening'. */
  async finalizeReply(): Promise<void> {
    if (this.state() !== 'speaking') return;
    this.streamDone = true;
    if (!this.tts) return;
    await this.drainSentences(true);
    // Wait for all in-flight speak() promises to resolve.
    while (this.activeSpeakCount > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // Back to listening for the next turn.
    this.state.set('listening');
    this.liveTranscript.set('');
    this.previewText.set('');
    await this.startUnderlyingRecognizer();
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
        // Too short; wait for more text unless we're at the end.
        return;
      }
      this.dispatchSpeak(piece);
      this.ttsBuffer = remainder;
    }
  }

  private dispatchSpeak(text: string): void {
    if (!this.tts) return;
    this.activeSpeakCount += 1;
    void this.tts
      .speak({ text, lang: TTS_LANG, queueStrategy: 1 /* Add */ })
      .catch((err) => console.error('[voice] speak failed', err))
      .finally(() => {
        this.activeSpeakCount = Math.max(0, this.activeSpeakCount - 1);
      });
  }

  /** Hard stop — used when the user cancels mid-turn or toggles
   *  voice off. */
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
    await this.detachListeners();
    this.ttsBuffer = '';
    this.activeSpeakCount = 0;
    this.streamDone = false;
    this.liveTranscript.set('');
    this.previewText.set('');
    this.state.set('off');
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}

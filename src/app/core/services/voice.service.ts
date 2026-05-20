import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

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

const STT_LANG = 'ro-RO';
const TTS_LANG = 'ro-RO';

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
      // finalize the transcript and bump transcriptReady.
      void stt.start({
        language: STT_LANG,
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
    this.state.set('speaking');
  }

  /** Streaming-TTS chunk. Composer calls this for every assistant
   *  chunk while state is 'speaking'. Sentence-buffer + queue. */
  async speakChunk(chunk: string): Promise<void> {
    if (this.state() !== 'speaking') return;
    if (!this.tts) return;
    this.ttsBuffer += chunk;
    await this.drainSentences(false);
  }

  /** End of stream: flush any remaining buffer, await all queued
   *  speech, then return to 'idle'. User taps the button to record
   *  the next turn — no auto-restart. */
  async finalizeReply(): Promise<void> {
    if (this.state() !== 'speaking') return;
    if (!this.tts) return;
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
    this.activeSpeakCount += 1;
    void this.tts
      .speak({ text, lang: TTS_LANG, queueStrategy: 1 /* Add */ })
      .catch((err) => console.error('[voice] speak failed', err))
      .finally(() => {
        this.activeSpeakCount = Math.max(0, this.activeSpeakCount - 1);
      });
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

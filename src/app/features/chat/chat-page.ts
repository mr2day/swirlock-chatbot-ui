import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { ChatStreamService } from '../../core/services/chat-stream.service';
import { SessionService } from '../../core/services/session.service';
import { PersonaService } from '../../core/services/persona.service';
import { VoiceService } from '../../core/services/voice.service';
import { Composer, type ComposerSendEvent } from './components/composer/composer';
import { MessageBubble } from './components/message-bubble/message-bubble';

@Component({
  selector: 'app-chat-page',
  imports: [Composer, MessageBubble],
  templateUrl: './chat-page.html',
  styleUrl: './chat-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatPage {
  /**
   * Bound from the route via `withComponentInputBinding()`. When the URL
   * is `/c/:sessionId`, this signal carries the id; on the root path it
   * is `undefined`.
   */
  readonly sessionId = input<string | undefined>(undefined);

  protected readonly session = inject(SessionService);
  protected readonly persona = inject(PersonaService);
  private readonly stream = inject(ChatStreamService);
  private readonly voice = inject(VoiceService);
  private readonly router = inject(Router);

  protected readonly thinkingSupported = this.stream.thinkingSupported;

  private readonly scrollHost = viewChild<ElementRef<HTMLElement>>('scrollHost');
  private readonly scrollSentinel = viewChild<ElementRef<HTMLElement>>('scrollSentinel');

  protected readonly hasMessages = computed(
    () => this.session.messages().length > 0,
  );

  /**
   * Hot-head autoscroll.
   *
   * Master switch: `userInteracting`. While true, the autoscroll
   * effect leaves the scroll position alone.
   *
   * Flip-to-true triggers (pause):
   *   - Pointer/wheel input while the user is actively dragging.
   *   - On scroll/release, the bottom sentinel is NOT in the
   *     visible part of the scroll container (user is reading
   *     above the live tail).
   *
   * Flip-to-false triggers (resume):
   *   - On scroll/release, the bottom sentinel IS visible (user
   *     scrolled back into the "hot head" — the strip where new
   *     tokens are appearing).
   *   - send() (user submitted a new turn → re-arm regardless).
   *
   * "Hot head" is the strict bottom of the message list — a 1px
   * sentinel right after the last message. Autoscroll only resumes
   * when the user has scrolled far enough that this sentinel is
   * within the scroll container's viewport. There is no fudge zone.
   */
  protected readonly userInteracting = signal<boolean>(false);

  /** True while a pointer is down on the scroll layer. Suppresses
   *  the scroll-event-based position recheck so we don't fight the
   *  user's drag. */
  private pointerActive = false;

  /** True when our autoscroll effect is the one writing scrollTop;
   *  we skip the scroll-event handler in this window so the
   *  programmatic write doesn't trigger a position recheck that
   *  would oscillate against itself. */
  private programmaticScrollUntil = 0;

  /** Pending rAF id for the throttled scroll-to-bottom writes during
   *  streaming, so we never do more than one scrollTop write per
   *  frame even if multiple chunks arrive in the same tick. */
  private pendingScrollRaf: number | null = null;

  constructor() {
    // Fetch the model's capability flags as soon as a chat page mounts so
    // the composer can hide affordances the model can't honor (e.g. the
    // "Force thinking" checkbox). Memoized in ChatStreamService — calling
    // it on every chat-page mount is fine.
    void this.stream.getModelInfo();

    // Whenever the route's sessionId changes, ask SessionService to load
    // the matching session. If the URL has no sessionId, just clear the
    // active session display.
    effect(() => {
      const id = this.sessionId();
      if (id) {
        untracked(() => void this.session.openSession(id));
      } else {
        untracked(() => this.session.clearActiveView());
      }
    });

    // Input + scroll-position tracker.
    //
    // Pointer down/wheel marks the user as actively interacting:
    // autoscroll pauses immediately so we don't fight the drag.
    //
    // Pointer up/cancel/leave reassesses based on whether the bottom
    // sentinel (the "hot head" — strict bottom of the message list)
    // is visible inside the scroll container:
    //   - sentinel visible → user is at the live tail, autoscroll
    //     resumes on the next chunk.
    //   - sentinel offscreen → user is reading history, autoscroll
    //     stays paused.
    //
    // The scroll event itself drives the same recheck during wheel
    // and trackpad scrolls (which have no explicit "release"). We
    // suppress the recheck during our own rAF-driven scrollTop
    // writes via programmaticScrollUntil to avoid feedback loops.
    effect((onCleanup) => {
      const host = this.scrollHost()?.nativeElement;
      if (!host) return;

      // Mark the user as interacting AND kill any in-flight programmatic
      // scroll. Without the cancel, a rAF scheduled before the touch
      // would still write scrollTop after the touch, and the user's
      // pause attempt would visibly fail for one more frame. On Android
      // the browser can hold pointerdown for ~100ms while it decides
      // if the touch is a scroll — `touchstart` fires sooner and gives
      // us the same intent earlier.
      const onPauseInput = () => {
        this.pointerActive = true;
        this.userInteracting.set(true);
        this.cancelScheduledScroll();
      };
      const onPointerEnd = () => {
        this.pointerActive = false;
        this.recheckPosition(host);
      };
      const onScroll = () => {
        if (this.pointerActive) return;
        if (performance.now() < this.programmaticScrollUntil) return;
        this.recheckPosition(host);
      };

      host.addEventListener('pointerdown', onPauseInput, { passive: true });
      host.addEventListener('touchstart', onPauseInput, { passive: true });
      host.addEventListener('pointerup', onPointerEnd, { passive: true });
      host.addEventListener('pointercancel', onPointerEnd, { passive: true });
      host.addEventListener('pointerleave', onPointerEnd, { passive: true });
      host.addEventListener('touchend', onPointerEnd, { passive: true });
      host.addEventListener('touchcancel', onPointerEnd, { passive: true });
      host.addEventListener('scroll', onScroll, { passive: true });
      onCleanup(() => {
        host.removeEventListener('pointerdown', onPauseInput);
        host.removeEventListener('touchstart', onPauseInput);
        host.removeEventListener('pointerup', onPointerEnd);
        host.removeEventListener('pointercancel', onPointerEnd);
        host.removeEventListener('pointerleave', onPointerEnd);
        host.removeEventListener('touchend', onPointerEnd);
        host.removeEventListener('touchcancel', onPointerEnd);
        host.removeEventListener('scroll', onScroll);
      });
    });

    // Single autoscroll effect. Tracks the last message's
    // content/status, the message-count delta, and userInteracting.
    //
    // Rules:
    //   - userInteracting === true → skip (user is in control).
    //   - countChanged → scroll to bottom (new turn / session load).
    //   - mid-stream → scroll to bottom, rAF-throttled.
    //
    // All scrollTop writes go through scheduleScrollToBottom which
    // coalesces into one write per animation frame — so a burst of
    // tokens in the same tick produces a single smooth scroll, not
    // a stack of synchronous jumps.
    let prevMessageCount = 0;
    effect(() => {
      const list = this.session.messages();
      const count = list.length;
      const last = list[count - 1];
      void last?.content;
      void last?.thinking;
      void last?.status;
      const interacting = this.userInteracting();
      const countChanged = count !== prevMessageCount;
      prevMessageCount = count;

      if (interacting) return;

      const host = this.scrollHost()?.nativeElement;
      if (!host) return;

      if (countChanged || this.session.isStreaming()) {
        this.scheduleScrollToBottom(host);
      }
    });

    // Stream assistant chunks into the VoiceService for TTS. Only
    // runs when voice mode is 'speaking' (set by send() before the
    // turn starts). Tracks the last seen message's content length so
    // we feed only deltas to speakChunk(). When the message status
    // flips to a terminal value, finalize so VoiceService swaps
    // back to 'listening' for the next turn.
    effect(() => {
      if (this.voice.state() !== 'speaking') return;
      const list = this.session.messages();
      const last = list[list.length - 1];
      if (!last || last.role !== 'assistant') return;
      if (last.localId !== this.ttsTrackedMessageId) {
        this.ttsTrackedMessageId = last.localId;
        this.ttsSpokenLength = 0;
      }
      if (last.content.length > this.ttsSpokenLength) {
        const delta = last.content.slice(this.ttsSpokenLength);
        this.ttsSpokenLength = last.content.length;
        void this.voice.speakChunk(delta);
      }
      if (
        last.status === 'done' ||
        last.status === 'error' ||
        last.status === 'cancelled'
      ) {
        this.ttsTrackedMessageId = null;
        this.ttsSpokenLength = 0;
        void this.voice.finalizeReply();
      }
    });
  }

  /** Tracks which assistant message we're currently feeding to TTS,
   *  so a session-switch or a new turn resets the spoken-length
   *  counter cleanly. */
  private ttsTrackedMessageId: string | null = null;
  private ttsSpokenLength = 0;

  /**
   * Snap-to-bottom write, throttled to once per animation frame.
   * Re-checks `userInteracting` inside the rAF — without this guard,
   * a chunk that arrived and scheduled this rAF *before* the user
   * touched the screen would still write scrollTop one more frame
   * after the touch, making touch-to-pause look broken on Android.
   * Sets programmaticScrollUntil briefly so the resulting scroll
   * event doesn't fire our recheckPosition handler and oscillate.
   */
  private scheduleScrollToBottom(host: HTMLElement): void {
    if (this.pendingScrollRaf != null) return;
    this.pendingScrollRaf = requestAnimationFrame(() => {
      this.pendingScrollRaf = null;
      if (this.userInteracting()) return;
      this.programmaticScrollUntil = performance.now() + 50;
      host.scrollTop = host.scrollHeight - host.clientHeight;
    });
  }

  private cancelScheduledScroll(): void {
    if (this.pendingScrollRaf != null) {
      cancelAnimationFrame(this.pendingScrollRaf);
      this.pendingScrollRaf = null;
    }
  }

  /**
   * Flips `userInteracting` based on whether the hot-head sentinel
   * is visible inside the scroll container.
   *
   * Sentinel-in-viewport === the user has scrolled to the strip
   * where new tokens are appearing. Anywhere else === reading
   * history.
   *
   * If the sentinel isn't in the DOM (empty greeting state) we
   * default to "follow" so a stray pointer event in that state
   * doesn't strand autoscroll off forever.
   */
  private recheckPosition(host: HTMLElement): void {
    const sentinel = this.scrollSentinel()?.nativeElement;
    if (!sentinel) {
      this.userInteracting.set(false);
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const sentinelRect = sentinel.getBoundingClientRect();
    const visible =
      sentinelRect.bottom > hostRect.top &&
      sentinelRect.top < hostRect.bottom;
    this.userInteracting.set(!visible);
  }


  protected async send(event: ComposerSendEvent): Promise<void> {
    const trimmed = event.text.trim();
    const hasImages = event.images.length > 0;
    if (!trimmed && !hasImages) return;
    // Sending a new message is an explicit "I'm engaged, show me the
    // answer" signal — re-arm autoscroll regardless of where the
    // viewport was.
    this.userInteracting.set(false);
    // If voice mode is on, stop the mic and prep the TTS pipeline
    // before the assistant's reply starts streaming in.
    if (this.voice.state() === 'listening' || this.voice.state() === 'preview') {
      await this.voice.beforeSpeakReply();
    }
    if (!this.session.activeId()) {
      try {
        const id = await this.session.newSession();
        await this.router.navigate(['/c', id]);
      } catch {
        return;
      }
    }
    void this.session.sendStream(trimmed, {
      forceThinking: event.forceThinking,
      images: event.images,
    });
  }

  protected stop(): void {
    this.session.cancelStream();
  }

  protected onGrantLocation(correlationId: string): void {
    void this.session.grantLocation(correlationId);
  }

  protected onDenyLocation(correlationId: string): void {
    this.session.denyLocation(correlationId);
  }
}

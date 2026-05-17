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
  private readonly router = inject(Router);

  protected readonly thinkingSupported = this.stream.thinkingSupported;

  private readonly scrollHost = viewChild<ElementRef<HTMLElement>>('scrollHost');
  private readonly scrollSentinel = viewChild<ElementRef<HTMLElement>>('scrollSentinel');

  protected readonly hasMessages = computed(
    () => this.session.messages().length > 0,
  );

  /**
   * Position-driven autoscroll, hot-zone based.
   *
   * Master switch: `userInteracting`. While true, the autoscroll
   * effect leaves the scroll position alone.
   *
   * Two triggers flip it true:
   *   - Pointer/wheel input while the user is actively dragging
   *     (pointerActive flag below).
   *   - Scroll position more than HOT_ZONE_PX from the bottom (user
   *     has scrolled up to read history).
   *
   * Two triggers flip it false:
   *   - Pointer release while scroll position is within HOT_ZONE_PX
   *     of the bottom (user let go near the live tail → autoscroll
   *     resumes for next chunk).
   *   - send() (user submitted a new turn → re-arm regardless).
   */
  protected readonly userInteracting = signal<boolean>(false);

  /** Distance-from-bottom (in px) below which we treat the user as
   *  "following the stream" and autoscroll re-engages on release.
   *  Above this distance, the user is reading history and we leave
   *  them alone. */
  private static readonly HOT_ZONE_PX = 200;

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
    // Pointer up/cancel/leave reassesses based on scroll position:
    //   - if the user let go inside the hot zone (within
    //     HOT_ZONE_PX of the bottom), they're following the live
    //     tail — autoscroll resumes on the next chunk.
    //   - if they let go outside the hot zone, they're reading
    //     older content — autoscroll stays paused.
    //
    // The scroll event itself drives the same recheck during wheel
    // and trackpad scrolls (which have no explicit "release"). We
    // suppress the recheck during our own rAF-driven scrollTop
    // writes via programmaticScrollUntil to avoid feedback loops.
    effect((onCleanup) => {
      const host = this.scrollHost()?.nativeElement;
      if (!host) return;

      const onPointerDown = () => {
        this.pointerActive = true;
        this.userInteracting.set(true);
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

      host.addEventListener('pointerdown', onPointerDown, { passive: true });
      host.addEventListener('pointerup', onPointerEnd, { passive: true });
      host.addEventListener('pointercancel', onPointerEnd, { passive: true });
      host.addEventListener('pointerleave', onPointerEnd, { passive: true });
      host.addEventListener('scroll', onScroll, { passive: true });
      onCleanup(() => {
        host.removeEventListener('pointerdown', onPointerDown);
        host.removeEventListener('pointerup', onPointerEnd);
        host.removeEventListener('pointercancel', onPointerEnd);
        host.removeEventListener('pointerleave', onPointerEnd);
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
  }

  /**
   * Snap-to-bottom write, throttled to once per animation frame.
   * Sets programmaticScrollUntil briefly so the resulting scroll
   * event doesn't fire our recheckPosition handler and oscillate.
   */
  private scheduleScrollToBottom(host: HTMLElement): void {
    if (this.pendingScrollRaf != null) return;
    this.pendingScrollRaf = requestAnimationFrame(() => {
      this.pendingScrollRaf = null;
      this.programmaticScrollUntil = performance.now() + 50;
      host.scrollTop = host.scrollHeight - host.clientHeight;
    });
  }

  /**
   * Reads the current distance from the bottom of the scroll
   * container and flips `userInteracting` accordingly. If the user
   * is within HOT_ZONE_PX of the bottom they're "following the
   * stream" and autoscroll re-engages. Outside that, they're
   * reading history and autoscroll stays off.
   */
  private recheckPosition(host: HTMLElement): void {
    const distance =
      host.scrollHeight - host.scrollTop - host.clientHeight;
    this.userInteracting.set(distance > ChatPage.HOT_ZONE_PX);
  }


  protected async send(event: ComposerSendEvent): Promise<void> {
    const trimmed = event.text.trim();
    const hasImages = event.images.length > 0;
    if (!trimmed && !hasImages) return;
    // Sending a new message is an explicit "I'm engaged, show me the
    // answer" signal — re-arm autoscroll regardless of where the
    // viewport was.
    this.userInteracting.set(false);
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

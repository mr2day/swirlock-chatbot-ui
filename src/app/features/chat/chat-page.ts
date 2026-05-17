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
   * Autoscroll behaviour switch.
   *
   * `false` (current default) — sticky-stop: once the user interacts
   * with the scroll layer (pointerdown / wheel), autoscroll stops for
   * the rest of the session and never re-engages automatically. The
   * user must scroll to the bottom themselves if they want to follow
   * the stream again. Page reload resets to "autoscroll on".
   *
   * `true` — legacy: the older "500ms release timer + hot-zone +
   * ease-in-out catch-up" behaviour. Kept in the codebase so we can
   * flip back to it without rewriting if the sticky-stop UX needs
   * to be reverted.
   */
  private static readonly LEGACY_AUTOSCROLL = false;

  /**
   * Flips true the first time the user touches/clicks/wheels inside
   * the scroll area. While true, the autoscroll effect leaves the
   * scroll position alone.
   *
   * In LEGACY mode this transitions back to false 500ms after the
   * last input event. In sticky-stop mode (default) it never
   * transitions back automatically — the user is in manual control
   * for the rest of the session.
   */
  protected readonly userInteracting = signal<boolean>(false);
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  /** How long after the last input event before we treat the user as
   *  "done" and resume autoscroll. LEGACY mode only. */
  private static readonly USER_RELEASE_DELAY_MS = 500;

  /** Smooth release-snap is only applied when the user's viewport is
   *  this close to the bottom — i.e. they're reading near the live
   *  tail. If they're farther up reading older content, releasing
   *  shouldn't yank them anywhere. LEGACY mode only. */
  private static readonly HOT_ZONE_PX = 2000;

  /** Duration of the ease-in-out animation on the release-snap.
   *  LEGACY mode only. */
  private static readonly EASE_DURATION_MS = 400;

  /** Pending rAF id for the release-snap animation, so we can cancel
   *  if the user touches the page again before it finishes. LEGACY
   *  mode only. */
  private easeRafId: number | null = null;

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

    // Track user *input* directly. Any pointer-down or wheel inside
    // the scroll area sets `userInteracting=true`.
    //
    // In LEGACY mode the release path (pointerup/cancel/leave or
    // 500ms after the last wheel) sets it back to false with a
    // half-second grace delay.
    //
    // In sticky-stop mode (default) the release path is a no-op:
    // once the user has touched the scroll layer, autoscroll stays
    // off for the rest of the session.
    effect((onCleanup) => {
      const host = this.scrollHost()?.nativeElement;
      if (!host) return;
      const begin = () => {
        if (ChatPage.LEGACY_AUTOSCROLL) {
          if (this.releaseTimer) {
            clearTimeout(this.releaseTimer);
            this.releaseTimer = null;
          }
          if (this.easeRafId != null) {
            cancelAnimationFrame(this.easeRafId);
            this.easeRafId = null;
          }
        }
        this.userInteracting.set(true);
      };
      const scheduleEnd = () => {
        if (!ChatPage.LEGACY_AUTOSCROLL) return;
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.releaseTimer = setTimeout(() => {
          this.userInteracting.set(false);
          this.releaseTimer = null;
        }, ChatPage.USER_RELEASE_DELAY_MS);
      };
      const onWheel = () => {
        begin();
        scheduleEnd();
      };
      host.addEventListener('pointerdown', begin, { passive: true });
      host.addEventListener('pointerup', scheduleEnd, { passive: true });
      host.addEventListener('pointercancel', scheduleEnd, { passive: true });
      host.addEventListener('pointerleave', scheduleEnd, { passive: true });
      host.addEventListener('wheel', onWheel, { passive: true });
      onCleanup(() => {
        host.removeEventListener('pointerdown', begin);
        host.removeEventListener('pointerup', scheduleEnd);
        host.removeEventListener('pointercancel', scheduleEnd);
        host.removeEventListener('pointerleave', scheduleEnd);
        host.removeEventListener('wheel', onWheel);
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
      });
    });

    // Single autoscroll effect. Tracks the last message's
    // content/status, the message-count delta, and userInteracting.
    //
    // Sticky-stop mode (default):
    //   - userInteracting === true → never scroll (forever).
    //   - countChanged → instant scroll (covers session load + new turn).
    //   - mid-stream → instant scroll.
    //
    // Legacy mode (ChatPage.LEGACY_AUTOSCROLL === true):
    //   - userInteracting === true → never scroll (until 500ms release).
    //   - countChanged → instant scroll.
    //   - mid-stream + within HOT_ZONE_PX → instant scroll.
    //   - mid-stream + outside hot zone → no scroll.
    //   - just released inside hot zone → ease-in-out catch-up,
    //     with EASE_DURATION_MS lockout against the next chunk.
    let prevMessageCount = 0;
    let wasInteracting = false;
    let smoothLockoutUntil = 0;
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
      const justReleased = wasInteracting && !interacting;
      wasInteracting = interacting;

      if (interacting) return;

      const host = this.scrollHost()?.nativeElement;
      const sentinel = this.scrollSentinel()?.nativeElement;
      if (!host || !sentinel) return;

      if (countChanged) {
        sentinel.scrollIntoView({
          block: 'end',
          inline: 'nearest',
          behavior: 'auto',
        });
        return;
      }

      if (!this.session.isStreaming()) return;

      if (ChatPage.LEGACY_AUTOSCROLL) {
        const distance =
          host.scrollHeight - host.scrollTop - host.clientHeight;
        if (distance > ChatPage.HOT_ZONE_PX) return;

        if (justReleased) {
          smoothLockoutUntil = performance.now() + ChatPage.EASE_DURATION_MS;
          this.easeScrollToBottom(host);
          return;
        }

        // Stream chunk. If the ease-in-out release-snap animation is
        // still running, skip — we don't want an instant scrollTop
        // write to break the easing. Subsequent chunks pick up as
        // soon as the lockout expires.
        if (performance.now() < smoothLockoutUntil) return;
      }

      sentinel.scrollIntoView({
        block: 'end',
        inline: 'nearest',
        behavior: 'auto',
      });
    });
  }

  /**
   * Hand-rolled rAF ease-in-out animation from the current scrollTop
   * to the bottom of the scroll container. We do this instead of
   * `scrollIntoView({behavior:'smooth'})` because the native smooth
   * is implementation-defined: in some browsers and in some
   * scroll-container configurations it falls back to instant.
   * Cancels any animation already in flight.
   */
  private easeScrollToBottom(host: HTMLElement): void {
    if (this.easeRafId != null) {
      cancelAnimationFrame(this.easeRafId);
      this.easeRafId = null;
    }
    const start = host.scrollTop;
    const target = host.scrollHeight - host.clientHeight;
    const change = target - start;
    if (Math.abs(change) < 1) return;
    const startTime = performance.now();
    const duration = ChatPage.EASE_DURATION_MS;
    // Classic cubic ease-in-out: slow start, fast middle, slow end.
    const ease = (t: number): number =>
      t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const step = (now: number): void => {
      const elapsed = now - startTime;
      if (elapsed >= duration) {
        host.scrollTop = target;
        this.easeRafId = null;
        return;
      }
      host.scrollTop = start + change * ease(elapsed / duration);
      this.easeRafId = requestAnimationFrame(step);
    };
    this.easeRafId = requestAnimationFrame(step);
  }


  protected async send(event: ComposerSendEvent): Promise<void> {
    const trimmed = event.text.trim();
    const hasImages = event.images.length > 0;
    if (!trimmed && !hasImages) return;
    // Sending a new message is an explicit "I'm engaged, show me the
    // answer" signal — re-arm autoscroll. In sticky-stop mode the
    // user might have tapped earlier and flipped userInteracting
    // permanently true; without this reset, the assistant's reply
    // would arrive below the textarea with no scroll-to-view.
    if (this.easeRafId != null) {
      cancelAnimationFrame(this.easeRafId);
      this.easeRafId = null;
    }
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

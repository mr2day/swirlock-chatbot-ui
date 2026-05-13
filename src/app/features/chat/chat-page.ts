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
   * Flips true while the user is actively touching/clicking/wheeling
   * inside the scroll area. While true, the autoscroll effect leaves
   * the scroll position alone. Transitions back to false 500ms after
   * the last input event (USER_RELEASE_DELAY_MS), giving the user a
   * comfortable grace window before the page starts moving on them
   * again.
   */
  protected readonly userInteracting = signal<boolean>(false);
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  /** How long after the last input event before we treat the user as
   *  "done" and resume autoscroll. */
  private static readonly USER_RELEASE_DELAY_MS = 500;

  /** Smooth release-snap is only applied when the user's viewport is
   *  this close to the bottom — i.e. they're reading near the live
   *  tail. If they're farther up reading older content, releasing
   *  shouldn't yank them anywhere. */
  private static readonly HOT_ZONE_PX = 300;

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
    // the scroll area sets `userInteracting=true`. The release path
    // (pointerup, pointercancel, pointerleave, or 500ms after the
    // last wheel) sets it back to false — but with a half-second
    // grace delay so the page doesn't snap back the instant the user
    // lifts their finger.
    effect((onCleanup) => {
      const host = this.scrollHost()?.nativeElement;
      if (!host) return;
      const begin = () => {
        if (this.releaseTimer) {
          clearTimeout(this.releaseTimer);
          this.releaseTimer = null;
        }
        this.userInteracting.set(true);
      };
      const scheduleEnd = () => {
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.releaseTimer = setTimeout(() => {
          this.userInteracting.set(false);
          this.releaseTimer = null;
        }, ChatPage.USER_RELEASE_DELAY_MS);
      };
      const onWheel = () => {
        begin();
        // Each wheel event resets the timer; "wheel ended" =
        // USER_RELEASE_DELAY_MS without further wheel events.
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

    // Continuous autoscroll while the stream is running and the user
    // isn't touching the page. Reads `userInteracting` via untracked
    // so this effect only fires on message changes, not on the
    // user-interaction transitions (those are handled below).
    // `behavior: auto` (instant) — combined with the host's
    // `overflow-anchor: auto` CSS, the visual is smooth without any
    // animation queueing.
    let prevMessageCount = 0;
    effect(() => {
      const list = this.session.messages();
      const count = list.length;
      const last = list[count - 1];
      void last?.content;
      void last?.thinking;
      void last?.status;
      const countChanged = count !== prevMessageCount;
      prevMessageCount = count;
      if (untracked(() => this.userInteracting())) return;
      if (!this.session.isStreaming() && !countChanged) return;
      const sentinel = this.scrollSentinel()?.nativeElement;
      if (!sentinel) return;
      sentinel.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' });
    });

    // Release-snap. Fires only on the userInteracting true→false
    // transition. Two extra gates:
    //   • streaming must still be active — otherwise the user has
    //     deliberately scrolled to read finished content and we
    //     shouldn't yank them
    //   • the viewport must be within HOT_ZONE_PX of the bottom —
    //     i.e. they're reading near the live tail, not scrolled far
    //     up reading old material
    // When both pass, scroll smoothly so the user perceives the
    // page easing back to the latest content (ease-in-out via the
    // browser's default smooth-scroll curve).
    let wasInteracting = false;
    effect(() => {
      const interacting = this.userInteracting();
      const justReleased = wasInteracting && !interacting;
      wasInteracting = interacting;
      if (!justReleased) return;
      if (!this.session.isStreaming()) return;
      const host = this.scrollHost()?.nativeElement;
      const sentinel = this.scrollSentinel()?.nativeElement;
      if (!host || !sentinel) return;
      const distance = host.scrollHeight - host.scrollTop - host.clientHeight;
      if (distance > ChatPage.HOT_ZONE_PX) return;
      sentinel.scrollIntoView({
        block: 'end',
        inline: 'nearest',
        behavior: 'smooth',
      });
    });
  }


  protected async send(event: ComposerSendEvent): Promise<void> {
    const trimmed = event.text.trim();
    const hasImages = event.images.length > 0;
    if (!trimmed && !hasImages) return;
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

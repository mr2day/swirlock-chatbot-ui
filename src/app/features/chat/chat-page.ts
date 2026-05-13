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
   * True while the user's viewport is within STICK_TO_BOTTOM_PX of the
   * scroll container's bottom. While anchored, new tokens auto-scroll
   * the view; once the user scrolls up the anchor releases and we
   * leave them where they are.
   */
  protected readonly anchored = signal<boolean>(true);
  /** Show the floating "↓ jump to latest" button while the stream is
   *  producing tokens and the user has scrolled away from the bottom. */
  protected readonly showJumpToLatest = computed(
    () => !this.anchored() && this.session.isStreaming(),
  );

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

    // Anchor management via IntersectionObserver. The sentinel sits
    // at the bottom of the message list; if the user has scrolled
    // it out of view, `anchored` flips to false and autoscroll
    // disengages. When the user scrolls (or the autoscroll lands)
    // the sentinel back into view, `anchored` flips to true and
    // autoscroll re-engages on the next chunk. Critically, the
    // observer doesn't care about scroll *events* — it just reports
    // whether the sentinel is visible — so it never races with the
    // autoscroll's own scrollTop writes the way an event listener
    // would. This is the same primitive ChatGPT/Claude use.
    effect((onCleanup) => {
      const host = this.scrollHost()?.nativeElement;
      const sentinel = this.scrollSentinel()?.nativeElement;
      if (!host || !sentinel) return;
      const observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            this.anchored.set(e.isIntersecting);
          }
        },
        { root: host, threshold: 0 },
      );
      observer.observe(sentinel);
      onCleanup(() => observer.disconnect());
    });

    // When new content streams in and the user is anchored, scroll
    // the sentinel into view. `scrollIntoView` is a single browser-
    // optimised call (no manual scrollTop arithmetic, no rAF write
    // queue), and `overflow-anchor: auto` on the host means content
    // added at the bottom doesn't shift the viewport even between
    // our explicit writes — so the result reads as one continuous,
    // smooth stream rather than a frame-by-frame yank.
    effect(() => {
      const list = this.session.messages();
      const last = list[list.length - 1];
      void last?.content;
      void last?.thinking;
      void last?.status;
      if (!this.anchored()) return;
      const sentinel = this.scrollSentinel()?.nativeElement;
      if (!sentinel) return;
      sentinel.scrollIntoView({ block: 'end', inline: 'nearest' });
    });
  }

  /** "Jump to latest" floating button handler — snap to bottom; the
   *  IntersectionObserver will re-anchor automatically once the
   *  sentinel intersects again. */
  protected jumpToLatest(): void {
    const sentinel = this.scrollSentinel()?.nativeElement;
    if (!sentinel) return;
    sentinel.scrollIntoView({ block: 'end', inline: 'nearest' });
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

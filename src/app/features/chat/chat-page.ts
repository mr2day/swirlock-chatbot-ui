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
   * the scroll position alone — the user can grab the page and read.
   * The moment they let go, the effect re-runs and resumes
   * autoscrolling if there's still streaming content to follow.
   */
  protected readonly userInteracting = signal<boolean>(false);
  private wheelEndTimer: ReturnType<typeof setTimeout> | null = null;

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
    // the scroll area = "user is interacting"; pointer release =
    // not interacting. Wheel has no natural release, so debounce
    // it 250ms after the last wheel event. We deliberately don't
    // look at scroll position or scroll events — those race with
    // our own autoscroll writes and we lose either way.
    effect((onCleanup) => {
      const host = this.scrollHost()?.nativeElement;
      if (!host) return;
      const start = () => this.userInteracting.set(true);
      const end = () => this.userInteracting.set(false);
      const onWheel = () => {
        this.userInteracting.set(true);
        if (this.wheelEndTimer) clearTimeout(this.wheelEndTimer);
        this.wheelEndTimer = setTimeout(() => {
          this.userInteracting.set(false);
          this.wheelEndTimer = null;
        }, 250);
      };
      host.addEventListener('pointerdown', start, { passive: true });
      host.addEventListener('pointerup', end, { passive: true });
      host.addEventListener('pointercancel', end, { passive: true });
      host.addEventListener('pointerleave', end, { passive: true });
      host.addEventListener('wheel', onWheel, { passive: true });
      onCleanup(() => {
        host.removeEventListener('pointerdown', start);
        host.removeEventListener('pointerup', end);
        host.removeEventListener('pointercancel', end);
        host.removeEventListener('pointerleave', end);
        host.removeEventListener('wheel', onWheel);
        if (this.wheelEndTimer) clearTimeout(this.wheelEndTimer);
      });
    });

    // Autoscroll. Re-runs on every message-content change AND on
    // every userInteracting transition, so:
    //   - mid-stream + not interacting → scroll to latest token
    //   - mid-stream + interacting → skip; user is reading
    //   - user releases mid-stream → effect re-runs because
    //     userInteracting changed → snap back to bottom and
    //     resume autoscroll on the next chunk
    //   - new session loaded / new turn started → countChanged
    //     triggers a one-time scroll-to-bottom even outside streaming
    //   - streaming over + user scrolls up → effect re-runs but
    //     both gates fail (not streaming, no new message), so we
    //     leave them alone
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
      if (this.userInteracting()) return;
      if (!this.session.isStreaming() && !countChanged) return;
      const sentinel = this.scrollSentinel()?.nativeElement;
      if (!sentinel) return;
      sentinel.scrollIntoView({ block: 'end', inline: 'nearest' });
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

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { SessionService } from '../../core/services/session.service';
import { PersonaService } from '../../core/services/persona.service';
import { Composer } from './components/composer/composer';
import { MessageBubble } from './components/message-bubble/message-bubble';
import { EmptyState } from './components/empty-state/empty-state';

@Component({
  selector: 'app-chat-page',
  imports: [Composer, MessageBubble, EmptyState],
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
  private readonly router = inject(Router);

  private readonly scrollHost = viewChild<ElementRef<HTMLElement>>('scrollHost');

  constructor() {
    // Whenever the route's sessionId changes, ask SessionService to load
    // the matching session. If the URL has no sessionId, just clear the
    // active session display (the empty state takes over).
    effect(() => {
      const id = this.sessionId();
      if (id && id !== this.session.activeId()) {
        void this.session.openSession(id);
      }
    });

    // Auto-scroll the message list to the bottom whenever new messages
    // appear or the assistant stream appends a chunk. We read both the
    // length and the last message's content so the effect re-runs on
    // every chunk during streaming.
    effect(() => {
      const list = this.session.messages();
      const last = list[list.length - 1];
      // Touch fields that change during streaming so the effect tracks them.
      void last?.content;
      void last?.thinking;
      void last?.status;
      const host = this.scrollHost()?.nativeElement;
      if (!host) return;
      queueMicrotask(() => {
        host.scrollTop = host.scrollHeight;
      });
    });
  }

  protected async startNewChat(): Promise<void> {
    try {
      const id = await this.session.newSession();
      await this.router.navigate(['/c', id]);
    } catch {
      /* surfaced via SessionService.error */
    }
  }

  protected async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.session.activeId()) {
      try {
        const id = await this.session.newSession();
        await this.router.navigate(['/c', id]);
      } catch {
        return;
      }
    }
    this.session.sendStream(trimmed);
  }

  protected stop(): void {
    this.session.cancelStream();
  }
}

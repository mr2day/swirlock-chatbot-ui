import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
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

  protected readonly hasMessages = computed(
    () => this.session.messages().length > 0,
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

    // Auto-scroll the message list to the bottom whenever messages change
    // or the assistant stream appends a chunk.
    effect(() => {
      const list = this.session.messages();
      const last = list[list.length - 1];
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

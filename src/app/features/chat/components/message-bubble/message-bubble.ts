import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import type { ChatMessage } from '../../../../core/models/chat-message.model';
import type { Persona } from '../../../../core/personas/persona.model';
import { renderMarkdownSafe } from '../../../../core/markdown/markdown';

@Component({
  selector: 'app-message-bubble',
  imports: [],
  templateUrl: './message-bubble.html',
  styleUrl: './message-bubble.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageBubble {
  readonly message = input.required<ChatMessage>();
  readonly persona = input.required<Persona>();

  private readonly sanitizer = inject(DomSanitizer);

  protected readonly thinkingOpen = signal<boolean>(false);

  protected readonly contentHtml = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(
      renderMarkdownSafe(this.message().content),
    ),
  );

  protected readonly hasThinking = computed<boolean>(
    () => this.message().thinking.length > 0,
  );

  protected readonly statusLabel = computed<string | null>(() => {
    const m = this.message();
    if (m.role !== 'assistant') return null;
    switch (m.status) {
      case 'pending':
        return 'Connecting…';
      case 'queued':
        return 'Queued…';
      case 'retrieving':
        // The retrieval-specific label is rendered via `retrievalStatus`;
        // no need to duplicate it as a generic status.
        return null;
      case 'thinking':
        return 'Thinking…';
      case 'streaming':
        return null;
      case 'cancelled':
        return 'Stopped';
      case 'error':
        return m.errorMessage ?? 'Something went wrong';
      default:
        return null;
    }
  });

  protected readonly isStreamingActive = computed<boolean>(() => {
    const s = this.message().status;
    return (
      s === 'pending' ||
      s === 'queued' ||
      s === 'retrieving' ||
      s === 'thinking' ||
      s === 'streaming'
    );
  });

  protected toggleThinking(): void {
    this.thinkingOpen.update((v) => !v);
  }
}

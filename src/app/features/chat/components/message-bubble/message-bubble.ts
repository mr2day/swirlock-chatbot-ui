import {
  ChangeDetectionStrategy,
  Component,
  computed,
  EventEmitter,
  inject,
  input,
  Output,
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

  @Output() readonly grantLocation = new EventEmitter<string>();
  @Output() readonly denyLocation = new EventEmitter<string>();

  private readonly sanitizer = inject(DomSanitizer);

  protected readonly thinkingOpen = signal<boolean>(true);

  protected readonly locationPrompt = computed(() => this.message().locationPrompt);

  protected onAllowLocation(): void {
    const prompt = this.message().locationPrompt;
    if (prompt && prompt.pending) {
      this.grantLocation.emit(prompt.correlationId);
    }
  }

  protected onDenyLocation(): void {
    const prompt = this.message().locationPrompt;
    if (prompt && prompt.pending) {
      this.denyLocation.emit(prompt.correlationId);
    }
  }

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
      case 'classifying':
        return 'Classifying...';
      case 'queued':
        return 'Queued...';
      case 'retrieving':
        return null;
      case 'awaiting_location':
        return null;
      case 'thinking':
        return 'Thinking...';
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
      s === 'classifying' ||
      s === 'queued' ||
      s === 'retrieving' ||
      s === 'awaiting_location' ||
      s === 'thinking' ||
      s === 'streaming'
    );
  });

  protected toggleThinking(): void {
    this.thinkingOpen.update((v) => !v);
  }
}

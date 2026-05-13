import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  EventEmitter,
  effect,
  inject,
  input,
  Output,
  signal,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import type { ChatMessage } from '../../../../core/models/chat-message.model';
import type { Persona } from '../../../../core/personas/persona.model';
import { renderMarkdownSafe } from '../../../../core/markdown/markdown';
import { ChatStreamService } from '../../../../core/services/chat-stream.service';

const STREAM_RENDER_INTERVAL_MS = 120;

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
  private readonly stream = inject(ChatStreamService);

  /** LLM model id (e.g. `gemma3:12b`) — shown under the persona name on assistant messages. */
  protected readonly modelId = this.stream.modelId;

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

  /** Coalesced version of `message().content`: during streaming, only
   *  re-renders the markdown at most every STREAM_RENDER_INTERVAL_MS;
   *  the moment the status flips to a terminal state we flush the
   *  latest content immediately so the user never sees stale prose. */
  protected readonly renderedContent = signal<string>('');
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => {
      if (this.throttleTimer != null) {
        clearTimeout(this.throttleTimer);
        this.throttleTimer = null;
      }
    });

    effect(() => {
      const m = this.message();
      const content = m.content;
      const isFinal =
        m.status === 'done' ||
        m.status === 'error' ||
        m.status === 'cancelled' ||
        m.role === 'user';
      if (isFinal) {
        if (this.throttleTimer != null) {
          clearTimeout(this.throttleTimer);
          this.throttleTimer = null;
        }
        this.renderedContent.set(content);
        return;
      }
      // Mid-stream: leave the pending timer to fire on its own clock.
      // Its closure reads the latest message().content when it runs,
      // so we always catch up to the freshest text.
      if (this.throttleTimer != null) return;
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        this.renderedContent.set(this.message().content);
      }, STREAM_RENDER_INTERVAL_MS);
    });
  }

  protected readonly contentHtml = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(
      renderMarkdownSafe(this.renderedContent()),
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

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

export interface ComposerSendEvent {
  text: string;
  forceThinking: boolean;
}

@Component({
  selector: 'app-composer',
  imports: [FormsModule],
  templateUrl: './composer.html',
  styleUrl: './composer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Composer {
  readonly streaming = input<boolean>(false);
  readonly disabled = input<boolean>(false);
  readonly personaName = input<string>('');
  /** Hide the "Force thinking" checkbox when the model doesn't support it. */
  readonly thinkingSupported = input<boolean>(true);

  readonly send = output<ComposerSendEvent>();
  readonly stop = output<void>();

  protected readonly text = signal<string>('');
  protected readonly forceThinking = signal<boolean>(false);

  private readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>('textarea');

  constructor() {
    // Auto-resize the textarea up to a comfortable mobile-friendly cap.
    effect(() => {
      void this.text();
      const el = this.textarea()?.nativeElement;
      if (!el) return;
      el.style.height = 'auto';
      const max = 200; // ~10 lines
      el.style.height = Math.min(el.scrollHeight, max) + 'px';
    });
  }

  protected onKeyDown(event: KeyboardEvent): void {
    // Enter sends; Shift+Enter inserts a newline (ChatGPT-style).
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.submit();
    }
  }

  protected submit(): void {
    if (this.streaming() || this.disabled()) return;
    const value = this.text().trim();
    if (!value) return;
    this.send.emit({ text: value, forceThinking: this.forceThinking() });
    this.text.set('');
    queueMicrotask(() => this.textarea()?.nativeElement?.focus());
  }

  protected onStop(): void {
    this.stop.emit();
  }

  protected placeholder(): string {
    const name = this.personaName();
    return name ? `Message ${name}…` : 'Type a message…';
  }
}

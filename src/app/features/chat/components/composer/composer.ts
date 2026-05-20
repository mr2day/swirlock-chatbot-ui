import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { VERSION } from '../../../../core/version';
import { VoiceService } from '../../../../core/services/voice.service';

export interface ComposerImage {
  id: string;
  dataUrl: string;
  mimeType: string;
  name: string;
}

export interface ComposerSendEvent {
  text: string;
  forceThinking: boolean;
  images: ComposerImage[];
}

let attachmentCounter = 0;
function nextAttachmentId(): string {
  attachmentCounter += 1;
  return `att-${Date.now().toString(36)}-${attachmentCounter}`;
}

function fileToImage(file: File): Promise<ComposerImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        id: nextAttachmentId(),
        dataUrl: String(reader.result),
        mimeType: file.type || 'image/png',
        name: file.name || 'image',
      });
    };
    reader.onerror = () => reject(new Error('Could not read image.'));
    reader.readAsDataURL(file);
  });
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

  protected readonly version = VERSION;
  protected readonly voice = inject(VoiceService);

  protected readonly text = signal<string>('');
  protected readonly forceThinking = signal<boolean>(false);
  protected readonly attachments = signal<ComposerImage[]>([]);
  protected readonly dragOver = signal<boolean>(false);

  private readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>('textarea');
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  /** Track previewReady/sendRequested counters so we react exactly
   *  once per event from the VoiceService. */
  private lastPreviewReady = 0;
  private lastSendRequested = 0;

  constructor() {
    // VoiceService → composer wiring:
    //   - When the user says "show preview" the VoiceService bumps
    //     `previewReady`. Copy `previewText` into the textarea so the
    //     user can edit it. Don't auto-send.
    //   - When the user says "send" while in preview, VoiceService
    //     bumps `sendRequested`. Submit the textarea.
    effect(() => {
      const n = this.voice.previewReady();
      if (n !== this.lastPreviewReady) {
        this.lastPreviewReady = n;
        const t = this.voice.previewText();
        if (t) {
          this.text.set(t);
          // Focus the textarea so the user sees the cursor; we do
          // NOT call our isTouch-aware blur path here because the
          // user is mid-voice-flow.
          setTimeout(() => this.textarea()?.nativeElement?.focus(), 0);
        }
      }
    });
    effect(() => {
      const n = this.voice.sendRequested();
      if (n !== this.lastSendRequested) {
        this.lastSendRequested = n;
        if (this.text().trim().length > 0 || this.attachments().length > 0) {
          this.submit();
        }
      }
    });

    // Auto-resize the textarea up to a comfortable mobile-friendly cap.
    effect(() => {
      const text = this.text();
      const el = this.textarea()?.nativeElement;
      if (!el) return;
      // Empty textarea: drop the inline height entirely so the CSS
      // `min-height` controls. Mobile webviews can be stingy about
      // recomputing `scrollHeight` after a value reset, so the
      // explicit clear is more reliable than auto + scrollHeight.
      if (text.length === 0) {
        el.style.height = '';
        return;
      }
      el.style.height = 'auto';
      // Force a synchronous layout pass between the reset and the
      // scrollHeight read — needed on Android webview.
      void el.offsetHeight;
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

  protected onPaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    // Keep the typed text untouched — only swallow the paste when it's
    // actually images, so plain-text pastes still drop into the textarea.
    event.preventDefault();
    void this.addImageFiles(files);
  }

  protected onDragOver(event: DragEvent): void {
    if (!event.dataTransfer) return;
    const hasFiles = Array.from(event.dataTransfer.items).some(
      (i) => i.kind === 'file',
    );
    if (!hasFiles) return;
    event.preventDefault();
    this.dragOver.set(true);
  }

  protected onDragLeave(event: DragEvent): void {
    // Ignore inner-element transitions; only clear when leaving the composer.
    const related = event.relatedTarget as Node | null;
    const host = (event.currentTarget as HTMLElement) ?? null;
    if (host && related && host.contains(related)) return;
    this.dragOver.set(false);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    void this.addImageFiles(Array.from(files));
  }

  protected onAttachClick(): void {
    this.fileInput()?.nativeElement.click();
  }

  protected onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      void this.addImageFiles(Array.from(input.files));
    }
    input.value = '';
  }

  protected removeAttachment(id: string): void {
    this.attachments.update((list) => list.filter((a) => a.id !== id));
  }

  private async addImageFiles(files: File[]): Promise<void> {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    const loaded = await Promise.all(images.map(fileToImage));
    this.attachments.update((list) => [...list, ...loaded]);
  }

  protected submit(): void {
    if (this.streaming() || this.disabled()) return;
    const value = this.text().trim();
    const images = this.attachments();
    if (!value && images.length === 0) return;
    this.send.emit({
      text: value,
      forceThinking: this.forceThinking(),
      images,
    });
    this.text.set('');
    this.attachments.set([]);
    const el = this.textarea()?.nativeElement;
    // On touch devices (mobile, tablet) keep focus off the textarea
    // after Send so the soft keyboard collapses and the user sees the
    // reply. On desktop, restore focus so the user can immediately
    // type the next message. `setTimeout(0)` rather than
    // `queueMicrotask` because emitting `send` flips the parent's
    // streaming() signal, which triggers an Angular re-render that
    // swaps the send button for the stop button — that DOM churn
    // happens AFTER microtasks but BEFORE the next task, so a
    // microtask-scheduled focus gets knocked off, while a
    // task-scheduled focus lands after the render has settled.
    const isTouch =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    if (isTouch) {
      el?.blur();
    } else {
      setTimeout(() => el?.focus(), 0);
    }
  }

  protected onStop(): void {
    this.stop.emit();
  }

  /** Mic toggle button. off → listening (with permission prompt on
   *  first use); anything else → off. */
  protected onMicToggle(): void {
    void this.voice.toggle();
  }

  protected placeholder(): string {
    const name = this.personaName();
    return name ? `Message ${name}…` : 'Type a message…';
  }
}

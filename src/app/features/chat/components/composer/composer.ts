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
  /** True when this turn was initiated by the voice flow (silence-
   *  auto-stop produced a transcript that was auto-submitted). The
   *  chat-page uses this to flip the VoiceService into 'speaking'
   *  mode so the assistant reply gets TTS'd. */
  fromVoice?: boolean;
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

  /** Track transcriptReady so we react exactly once per finalized
   *  voice utterance from the VoiceService. */
  private lastTranscriptReady = 0;

  constructor() {
    // VoiceService → composer wiring:
    //   When Android's SpeechRecognizer auto-stops on silence, the
    //   VoiceService bumps `transcriptReady`. We copy the transcript
    //   into the textarea AND submit immediately — classical
    //   press-to-talk: no preview, no edit step.
    effect(() => {
      const n = this.voice.transcriptReady();
      if (n !== this.lastTranscriptReady) {
        this.lastTranscriptReady = n;
        const t = this.voice.lastTranscript;
        if (t) {
          this.text.set(t);
          // Defer submit by one task so the textarea value reflects
          // the set() before submit reads it. fromVoice=true tells
          // chat-page to flip the VoiceService into 'speaking' so
          // the assistant reply gets TTS'd.
          setTimeout(() => this.submit(true), 0);
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

  protected submit(fromVoice = false): void {
    if (this.streaming() || this.disabled()) return;
    const value = this.text().trim();
    const images = this.attachments();
    if (!value && images.length === 0) return;
    this.send.emit({
      text: value,
      forceThinking: this.forceThinking(),
      images,
      fromVoice,
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

  /** Mic toggle button. idle → recording (permission prompt on
   *  first use); recording → cancel (no submit); speaking → stop TTS. */
  protected onMicToggle(): void {
    void this.voice.toggle();
  }

  protected micLabel(): string {
    switch (this.voice.state()) {
      case 'recording':
        return 'Cancel listening';
      case 'speaking':
        return 'Stop Gigi from speaking';
      default:
        return 'Listen';
    }
  }

  protected placeholder(): string {
    const name = this.personaName();
    return name ? `Message ${name}…` : 'Type a message…';
  }
}

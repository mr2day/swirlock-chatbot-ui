import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { Persona } from '../../../../core/personas/persona.model';

@Component({
  selector: 'app-empty-state',
  imports: [],
  templateUrl: './empty-state.html',
  styleUrl: './empty-state.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmptyState {
  readonly persona = input.required<Persona>();
  readonly busy = input<boolean>(false);
  readonly start = output<void>();

  protected readonly suggestions: readonly string[] = [
    'Tell me a short joke.',
    'Explain quantum entanglement like I am five.',
    'Help me draft a polite cancellation email.',
    'What is the weather like on Mars?',
  ];

  protected onStart(): void {
    this.start.emit();
  }
}

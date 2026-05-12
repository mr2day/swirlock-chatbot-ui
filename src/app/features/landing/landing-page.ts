import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { PersonaService } from '../../core/services/persona.service';
import { PersonaSwitcher } from '../../layouts/persona-switcher/persona-switcher';

@Component({
  selector: 'app-landing-page',
  standalone: true,
  imports: [RouterLink, PersonaSwitcher],
  templateUrl: './landing-page.html',
  styleUrl: './landing-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LandingPage {
  protected readonly persona = inject(PersonaService);
  protected readonly auth = inject(AuthService);

  protected signIn(): void {
    void this.auth.login('/chat');
  }
}

import { Routes } from '@angular/router';
import { authGuard, guestOnlyGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    canActivate: [guestOnlyGuard],
    loadComponent: () =>
      import('./features/landing/landing-page').then((m) => m.LandingPage),
  },
  {
    path: 'auth/callback',
    loadComponent: () =>
      import('./features/auth/auth-callback').then((m) => m.AuthCallback),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./layouts/main-layout/main-layout').then((m) => m.MainLayout),
    children: [
      {
        path: 'chat',
        loadComponent: () =>
          import('./features/chat/chat-page').then((m) => m.ChatPage),
      },
      {
        path: 'c/:sessionId',
        loadComponent: () =>
          import('./features/chat/chat-page').then((m) => m.ChatPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];

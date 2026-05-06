import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./layouts/main-layout/main-layout').then((m) => m.MainLayout),
    children: [
      {
        path: '',
        pathMatch: 'full',
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

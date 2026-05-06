# Gigi the Robot — logo asset

This folder is where the persona's logo image lives. The app references
it at the runtime path:

```
personas/gigi-the-robot/logo.png
```

Save the persona's chibi-robot artwork as `logo.png` in this folder. PNG
is preferred for the browser favicon and for the in-app avatar; the same
file is reused for the topbar avatar, the empty-state hero, and the
sidebar brand.

If the file is missing the app still runs — the browser will show a
broken-image icon in the avatar slots until the file is dropped in.

When swapping the artwork, update the `theme.background` color in
[`src/app/core/personas/gigi-the-robot.persona.ts`](../../../src/app/core/personas/gigi-the-robot.persona.ts)
to match the new image's background so the chat surface and the avatar
stay in visual harmony.

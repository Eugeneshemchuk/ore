# Knowledge Potential

A scroll-driven WebGL scene for claude.expert, served at `/ore/`. It loops
through four chapters: Signal (digital rain), Void (the particle mask),
Mind (the neural brain behind it) and Potential (the asteroid flyby).

Built with React, @react-three/fiber, three.js, Lenis and Vite.

## Develop

```sh
npm ci
npm run dev       # http://localhost:5173/ore/
```

## Build

```sh
npm run build     # type-checks, then writes dist/
npm run preview   # serves dist/ at /ore/
```

Pushing to `main` deploys `dist/` to GitHub Pages
(`.github/workflows/deploy.yml`).

## Notes

- Sound is on by default, but browsers only allow audio after a click, tap or
  key press, so it starts on the visitor's first such gesture. Turning it off
  is remembered in `localStorage` (`ore-sound`).
- `prefers-reduced-motion` disables the camera travel, particle flight and
  title animations.
- Audio samples live in `public/audio/`.

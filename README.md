# One More

Two small games that run in a browser.

- **One More Tune** — hear a few seconds of music and say which Apple
  advertisement or keynote it belonged to. Ten a round.
- **One More Take** — you are the props master on a period drama: match the
  machines to their years, colours and names before the film runs out.

## Play the demo

```bash
npm start
```

Then open `http://localhost:8080/tune/` or `http://localhost:8080/take/`.

This repository holds the games' code. The full decks and the server that
deals and marks a round are not here, so on its own page each game plays a
small recorded demo from `demo/`: one round of ten tunes, one set of ten
takes. Progress stays in the browser's local storage.

One More Tune plays short previews from Apple's public preview service and
can open a video on YouTube; both need a network connection.

## Build

```bash
npm run build
```

Copies what a host page embeds into `dist/`. There are no dependencies; Node
is enough. `demo/` is left out of the build.

## Layout

| Path | What it is |
| --- | --- |
| `tune/` | One More Tune: the page, the game, its wheel control, its stylesheet |
| `take/` | One More Take: the page, the game, its stylesheet |
| `shared/` | What both use: strings in English and Chinese, base styles, the runtime |
| `demo/` | The recorded demo: reduced decks and one recorded round |
| `ais6-bridge.js`, `kit.css`, `app.manifest.json` | Let a host page embed the games in frames, keep their progress and draw their menus; on their own page the same calls fall back to local storage |

## Licence

MIT. See [LICENSE](LICENSE).

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

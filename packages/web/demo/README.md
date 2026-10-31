# Demo video

`pnpm demo:video` records a captioned two-minute walkthrough of the viewer to
`demo-out/viewport-demo.webm`. Run `pnpm build` first.

It seeds a throwaway copy of the py-shop fixture (`seed.ts`) with the v2 model, five
decisions, answered questions and a flag Claude has answered, starts a daemon with no
background worker, and drives Chromium with a drawn cursor and caption bar
(`record.ts`). Midway it adds a search component the way Claude would, to show the Map
updating live.

To make an MP4 for sharing:

```
ffmpeg -i demo-out/viewport-demo.webm -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart viewport-demo.mp4
```

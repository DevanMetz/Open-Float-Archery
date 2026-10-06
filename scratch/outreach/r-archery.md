# r/Archery + ArcheryTalk draft (archer-facing, plain language)

## Title

I built a free, open-source sensor that shows your float and scores your
release — looking for beta archers

## Post

I've been working on an open-source project called OpenFloat: a small sensor
(about the size of a postage stamp) that mounts on your riser and records
exactly how your bow moves through every shot — your float during the hold,
the moment of release, and your follow-through.

After each shot you get a replay on your phone or laptop: the path your pin
traveled drawn over a target face, colored by phase (hold / release /
follow-through), plus a Float Score so you can track whether your hold is
actually getting steadier week to week. It also listens for the shot and the
target impact, so it can estimate your distance from time of flight.

A few things that make it different from commercial trainers:

- **It's free and open.** All the hardware design, firmware, and software are
  public. The board it runs on is a Seeed XIAO nRF54L15 Sense
  (TODO-verify-price: fill in current Seeed price before posting).
- **No app, no account.** It works in the Chrome/Edge browser over Bluetooth.
  Your shot data stays on your device.
- **It works offline at the range.** Shots are saved on the sensor itself if
  your phone is out of range and sync when you reconnect.

You can play with the dashboard right now without any hardware — the demo
loads with real recorded shots: https://openfloatarchery.com

**The ask:** I'm looking for a handful of archers (any discipline — compound,
recurve, barebow) willing to build or flash one and shoot with it, so we can
test how Float Score correlates with actual target scores across different
bows and setups. The build is about an hour, or ~10 minutes if you use the
prebuilt firmware and just flash it. Repo and instructions:
https://github.com/DevanMetz/Open-Float-Archery

Caveats up front: needs Chrome or Edge (no iPhones — Apple doesn't support
Web Bluetooth), you'll need a cheap USB debug probe to flash it, and battery
life numbers are still being characterized.

Happy to answer anything about how it works or what the data looks like.

## Notes

- r/Archery rules: check the sub's self-promotion policy; posting as "looking
  for beta testers / feedback" with the demo link is usually well received,
  spammy product drops are not. Engage in comments.
- ArcheryTalk: post in the appropriate equipment/DIY subforum; same text works.
- A short video/GIF of a real shot replay will do more than any paragraph —
  worth waiting for the screenshot/demo assets if you can.

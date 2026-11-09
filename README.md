ebutuoy backend

This is the backend service for ebutuoy, the video discovery app. It has no home page of its own.

It searches for little seen videos, remembers which ones have been served, supports a random geographic mode, tags videos, and tracks which are due to be replayed. It filters out videos that cannot play in the embedded player.

It also serves a TV mode with numbered channels from 1 to 1,000,000.

This app is checked every morning by Control Troll.

Latest change. 2026-11-09, v2026.11.09. Added numbered TV channels from 1 to 1,000,000. Each number is tied to one channel the first time it is tuned, found by random searches in any language and of any size. New routes serve a channel, its videos, and stats. Videos are kept for six hours before they are fetched again.

See CHANGELOG.md for the full history.

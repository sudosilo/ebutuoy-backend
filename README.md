ebutuoy backend

This is the backend service for ebutuoy, the video discovery app. It has no home page of its own.

It searches for little seen videos, remembers which ones have been served, supports a random geographic mode, tags videos, and tracks which are due to be replayed. It filters out videos that cannot play in the embedded player.

This app is checked every morning by Control Troll.

Latest change. Ran a bug hunt. Search now returns only videos that can play in the embed, and subscriber checks fail closed. Added paging and quota tracking. Data now lives on the volume when one exists, and the service exits cleanly and logs fatal errors.

See CHANGELOG.md for the full history.

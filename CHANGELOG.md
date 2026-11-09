2026-11-09, v2026.11.09. Added numbered TV channels from 1 to 1,000,000. Each number is tied to one channel the first time it is tuned, found by random searches in any language and of any size. New routes serve a channel, its videos, and stats. Videos are kept for six hours before they are fetched again.

2026-10-11, v2026.10.11. Ran a bug hunt. Search now returns only videos that can play in the embed, and subscriber checks fail closed. Added paging and quota tracking. Data now lives on the volume when one exists, and the service exits cleanly and logs fatal errors.

2026-05-27, v2026.05.27. Added a clips table and clip endpoints.

2026-05-19, v2026.05.19. Added a tag system and a replay queue for videos that become eligible after a day. Added a language filter and a playlist endpoint.

2026-05-18, v2026.05.18. Created the backend with a seen videos record and a search that favors less popular videos. Added a roulette mode that picks places weighted by population.

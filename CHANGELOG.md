# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-01

First public release.

### Added

- Status bar item showing the topped-up balance and today's cost, with a `compact` and a `full` text format.
- Markdown tooltip with the top-up balance, today's cost / API requests / total tokens, and an hourly cost table that names the model used in each hour.
- QuickPick on click: refresh, set API key, set usage token, set Cloudflare cookie, diagnostics, open the Usage page, open settings.
- Usage figures from the platform's internal `usage/by_api_key/amount` and `usage/by_api_key/cost` endpoints, with the daily window and timezone computed the same way the website does it.
- Low balance warning (configurable threshold, notification once per session).
- Focus-aware polling that pauses after 10 minutes without window focus and refreshes when focus returns.
- Snapshot caching so the status bar is populated immediately at startup.
- `DeepSeek: Diagnostics (open log)` command reporting endpoint, HTTP status and response *field names* only.
- Runtime-free self-check (`npm run selfcheck`) covering the parser, the cache normaliser, the timezone helpers and the response-shape reporting.

### Fixed during development

These issues were found and fixed before the first release; they are listed because each one is easy to reintroduce.

- **Timezone offset off by one second.** `Date.UTC(parts) - date.getTime()` mixes second-precision and millisecond-precision values, so the difference could be `25199.001`, which rounds to `25199` whenever the millisecond part exceeded 500. The shifted request window made the API return empty buckets and usage came back unavailable *intermittently*. The offset is now read from ICU via `timeZoneName: 'longOffset'`, with millisecond-free arithmetic as a fallback.
- **Stale cache broke activation.** A snapshot stored by an earlier build (without `hourly[].models`) was read unvalidated, so rendering threw a `TypeError` inside `activate()`. Everything after that line, including the polling timer, never ran, which looked like "the balance stopped updating". The cache key is now schema-versioned, cached payloads are normalised on read, tooltip rendering is guarded, and the timer starts before the first render.
- **Wrong usage endpoints.** The initial implementation followed third-party repositories and used `/api/v0/usage/amount?month=&year=` with a `days[].data[].usage[]` response shape. Probing the live API showed the real contract is `/api/v0/usage/by_api_key/{amount,cost}?start=&end=&tz=` returning `series[].buckets[]`, and that `?month=&year=` answers 422 while `by_model` answers 404.
- **Hourly breakdown reported as impossible.** The bucket size in the response is 3600 seconds, so the hourly table, originally assumed to need a separate endpoint, comes from the same request.
- **`4xx` responses were retried.** Non-retryable 4xx errors consumed three attempts with backoff; they now fail immediately, and only 429 and 5xx are retried.

## [kugelaudio-v1.1.0](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v1.0.1...js-sdk-v1.1.0) (2026-09-23)

## [kugelaudio-v1.0.1](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v1.0.0...js-sdk-v1.0.1) (2026-09-22)

## [kugelaudio-v1.0.0](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.12.0...js-sdk-v1.0.0) (2026-09-21)

## [kugelaudio-v0.12.0](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.11.0...js-sdk-v0.12.0) (2026-09-07)

## [kugelaudio-v0.11.0](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.10.0...js-sdk-v0.11.0) (2026-09-05)

## [kugelaudio-v0.10.0](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.9.2...js-sdk-v0.10.0) (2026-08-10)

### Features

* **js-sdk,python-sdk:** add speed and bound prewarm timeout in the LiveKit plugins ([#1823](https://github.com/Kugelaudio/KugelAudio/issues/1823)) ([94bd656](https://github.com/Kugelaudio/KugelAudio/commit/94bd6564a867c7910d73ab12b422f6129f420636))

## [kugelaudio-v0.9.2](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.9.1...js-sdk-v0.9.2) (2026-07-27)

### Bug Fixes

* **js-sdk:** correct type resolution for ESM and node10 consumers ([#1708](https://github.com/Kugelaudio/KugelAudio/issues/1708)) ([3747205](https://github.com/Kugelaudio/KugelAudio/commit/3747205b112ce7aa598685fc718fe541bf83f827))

## [kugelaudio-v0.9.1](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.9.0...js-sdk-v0.9.1) (2026-07-21)

### Bug Fixes

* **js-sdk:** flush buffered audio tail on chunk_complete in LiveKit plugin ([#1680](https://github.com/Kugelaudio/KugelAudio/issues/1680)) ([b647cbe](https://github.com/Kugelaudio/KugelAudio/commit/b647cbe6fc601df1347ab62934cf44137296ae31))

## [kugelaudio-v0.9.0](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.8.0...js-sdk-v0.9.0) (2026-07-08)

### Features

* **ingress:** per-span <prosody rate> speed control ([#1373](https://github.com/Kugelaudio/KugelAudio/issues/1373)) ([7861e88](https://github.com/Kugelaudio/KugelAudio/commit/7861e881cc9d89730f01681f72192ad7a6f3d2b8))
* **js-sdk:** add LiveKit Agents TTS plugin ([#1538](https://github.com/Kugelaudio/KugelAudio/issues/1538)) ([1b21c44](https://github.com/Kugelaudio/KugelAudio/commit/1b21c44b57ebfcd7cc19f9e1ea5c63e3aa4f4c71))
* update session settings per turn (KUG-1166) ([#1500](https://github.com/Kugelaudio/KugelAudio/issues/1500)) ([7521d35](https://github.com/Kugelaudio/KugelAudio/commit/7521d35d56925f2f76d6ac19f40bdd735680584c))

## [kugelaudio-v0.8.0](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.7.0...js-sdk-v0.8.0) (2026-06-10)

### Features

* **ingress,python-sdk,js-sdk,java-sdk:** per-session usage over WebSocket ([#1346](https://github.com/Kugelaudio/KugelAudio/issues/1346)) ([2881881](https://github.com/Kugelaudio/KugelAudio/commit/28818816dca9c8d222391691d70f458c0eb28ed8))
* **ingress,python-sdk,js-sdk:** streaming final end-of-audio frame ([#1362](https://github.com/Kugelaudio/KugelAudio/issues/1362)) ([3fa95d2](https://github.com/Kugelaudio/KugelAudio/commit/3fa95d2f8597e6c9ced0aaf8370682dbcb123c71))
* **ingress:** output_format token + server-side G.711 (KUG-1190) ([#1345](https://github.com/Kugelaudio/KugelAudio/issues/1345)) ([3723291](https://github.com/Kugelaudio/KugelAudio/commit/372329196c4c91aa41fe2111783872874b6e895b))
* per-request dictionary selection (KUG-1094) ([#1361](https://github.com/Kugelaudio/KugelAudio/issues/1361)) ([3c28968](https://github.com/Kugelaudio/KugelAudio/commit/3c28968d32018bf3cafe1d312f32831668ea96b8))

### Bug Fixes

* **js-sdk,java-sdk,ingress:** multi-turn conversations work end-to-end + live SDK e2e bench in CI (KUG-1233) ([#1363](https://github.com/Kugelaudio/KugelAudio/issues/1363)) ([c0ed2a9](https://github.com/Kugelaudio/KugelAudio/commit/c0ed2a9cf41025bac5c7182c1a281eb600d8dd36))

## [kugelaudio-v0.7.0](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.6.1...js-sdk-v0.7.0) (2026-06-06)

### Features

* **ingress:** add request observability metadata ([#1321](https://github.com/Kugelaudio/KugelAudio/issues/1321)) ([a9c5178](https://github.com/Kugelaudio/KugelAudio/commit/a9c5178193cb8b746a8bbd9b566b11f7b1d00f6d))
* **sdks:** default all SDKs to kugel-3 model ([#1323](https://github.com/Kugelaudio/KugelAudio/issues/1323)) ([c4de212](https://github.com/Kugelaudio/KugelAudio/commit/c4de212c91e16326a15dbee5622acacc83ed85bb))

### Bug Fixes

* **js-sdk:** type SDK metadata fetch mock ([#1334](https://github.com/Kugelaudio/KugelAudio/issues/1334)) ([e8f6f59](https://github.com/Kugelaudio/KugelAudio/commit/e8f6f59595e123eaae8b44670c94fb4e7bc8d06c))

## [kugelaudio-v0.6.1](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.6.0...js-sdk-v0.6.1) (2026-06-04)

### Bug Fixes

* **python-sdk:** propagate ingress errors through SDK integrations ([#1313](https://github.com/Kugelaudio/KugelAudio/issues/1313)) ([3ae2e03](https://github.com/Kugelaudio/KugelAudio/commit/3ae2e03745b49cca0712c20d9a658c160f4b6f38))

## [kugelaudio-v0.6.0](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.5.0...js-sdk-v0.6.0) (2026-06-01)

### Features

* streaming barge-in (cancelCurrent) across server + JS/Python/Java SDKs ([#1210](https://github.com/Kugelaudio/KugelAudio/issues/1210)) ([341e54f](https://github.com/Kugelaudio/KugelAudio/commit/341e54f169b4dd9242272b249fca30f005bfc3b8))

## [kugelaudio-v0.5.0](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.4.0...js-sdk-v0.5.0) (2026-05-21)

### Features

* **ingress,sdks:** public API for custom word dictionaries (KUG-765) ([#875](https://github.com/Kugelaudio/KugelAudio/issues/875)) ([9988924](https://github.com/Kugelaudio/KugelAudio/commit/99889244997d1cb4dba9714e2633d84ace9852a3))
* **sdk:** add NotFoundError for unknown resources (KUG-423) ([#872](https://github.com/Kugelaudio/KugelAudio/issues/872)) ([d613b0f](https://github.com/Kugelaudio/KugelAudio/commit/d613b0fa1314c9e9e1f2af924652d94014626ddc))

### Reverts

* undo accidental merge of PR [#723](https://github.com/Kugelaudio/KugelAudio/issues/723) ([e8eff2e](https://github.com/Kugelaudio/KugelAudio/commit/e8eff2e86c76b893262782ff6ae763ed405396ce))

## [kugelaudio-v0.4.0](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.3.0...js-sdk-v0.4.0) (2026-05-14)

### Features

* **web:** bump kugelaudio SDK to ^0.3.0 to enable per-project dictionary ([#640](https://github.com/Kugelaudio/KugelAudio/issues/640)) ([f503372](https://github.com/Kugelaudio/KugelAudio/commit/f5033728b2febb00cea6b021da5b5309c2c9097f))

### Bug Fixes

* **python-sdk,js-sdk,java-sdk:** update regional endpoints ([#660](https://github.com/Kugelaudio/KugelAudio/issues/660)) ([b9a32c0](https://github.com/Kugelaudio/KugelAudio/commit/b9a32c09813c3e9de34a9d0a84ed0e024e1fe158))

# Changelog

All notable changes to the KugelAudio JavaScript/TypeScript SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0](https://github.com/Kugelaudio/KugelAudio/compare/js-sdk-v0.2.3...js-sdk-v0.3.0) (2026-05-10)

### Features

* **temperature, projectId, speed** on `tts.stream` / `tts.generate` / multi-context. Required for per-project custom dictionary replacement on the website. ([#273](https://github.com/Kugelaudio/KugelAudio/pull/273))
* **error classification:** unify across SDKs with actionable messages ([#315](https://github.com/Kugelaudio/KugelAudio/pull/315))
* **multi-region routing** for all SDKs ([#227](https://github.com/Kugelaudio/KugelAudio/pull/227))

### Bug Fixes

* **streaming session close:** per-message-quiet timeout in `StreamingSession.close()` ([#528](https://github.com/Kugelaudio/KugelAudio/pull/528))
* **multi-context:** remove redundant `is_final` signal from protocol ([#279](https://github.com/Kugelaudio/KugelAudio/pull/279))
* **websocket:** keep alive across streaming sessions ([#253](https://github.com/Kugelaudio/KugelAudio/pull/253))
* **release pipeline:** fix stale repo URLs blocking semantic-release ([#637](https://github.com/Kugelaudio/KugelAudio/pull/637))

## [0.1.3] - 2024-12-25

### Fixed
- Fixed WebSocket authentication: now correctly uses `master_key` query param when `isMasterKey: true` is set, instead of always using `api_key`
- Added both `X-API-Key` header and `Authorization: Bearer` header for HTTP requests

## [0.1.0] - 2024-12-17

### Added
- Initial release of the KugelAudio JavaScript/TypeScript SDK
- **Models API**: List available TTS models (`client.models.list()`)
- **Voices API**: List voices (`client.voices.list()`) and get voice details (`client.voices.get()`)
- **TTS Generation**: Generate complete audio (`client.tts.generate()`)
- **Streaming**: Real-time audio streaming via WebSocket (`client.tts.stream()`)
- **Audio Utilities**: `createWavBlob()`, `createWavFile()`, `decodePCM16()`, `base64ToArrayBuffer()`
- **TypeScript**: Full type definitions for all APIs
- **Error Handling**: Typed exceptions for auth, rate limits, validation errors
- **Single URL Architecture**: Connect to TTS server directly for minimal latency
- **Browser Support**: Works in modern browsers with WebSocket support

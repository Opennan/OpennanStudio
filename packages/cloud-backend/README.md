# @opennan/cloud-backend

OpenNan cloud projects for OpenNan Studio (phase 9a). OpenNan Community License (as `@opennan/timeline-core`, which it builds on); runs in browsers and Node.

`OpenNanCloudBackend` implements timeline-core's `TimelineBackend`, `ProjectCatalog` and `MediaLibraryBackend` for
projects stored on opennan.com, so the editor screens do not change:

- **Local first.** Every edit lands on a local working copy (a `LocalBackend` the host provides) and is diffed into
  field-level deltas in the server's shape.
- **Atomic changesets.** Queued deltas merge into one `POST /v1/projects/{id}/changes` with `If-Match` and an
  `Idempotency-Key` (kept until the answer arrives, so a retry is never applied twice), split under the 2 MB cap.
- **Polling and rebase.** `GET /v1/projects/{id}/document` with ETag/304 every 3–15 s; on a newer revision or a
  412, pending edits are re-applied field by field (the later writer wins; a delete beats an edit). Only an edit
  that cannot apply becomes a conflict, and the pre-rebase copy can be kept as a local project.
- **Offline.** The queue, the confirmed document and the working copy live in a host `CloudStore` on disk.
- **Per-device undo**, sent as forward changesets.
- **Lossless.** Studio-only fields travel in `extras_json`; values a column cannot hold exactly are kept exactly.
- **Media.** SHA-256 streamed (`hashBlob`), account-scoped dedup uploads through single-use gateway links or
  multipart parts, and a download cache provided by the host.
- **`BackendRouter`** sends `cloud-<id>` projects to the cloud backend and every other project to the local one, so
  local projects never touch the network.

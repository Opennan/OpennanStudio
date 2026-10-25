# @opennan/director-client

The client for OpenNan's **project pipeline** routes, plus the script cue cutter. OpenNan Community License; runs in
browsers and Node.

**Not used by any Studio host.** OpenNan Studio keeps projects on the device and runs AI through OpenNan's tools and
models API (`@opennan/provider-opennan`). The pipelines below exist on OpenNan only as routes of a project stored on
OpenNan's server (`/v1/projects/{id}/...`), so they cannot run on a local project. This package keeps their request
shapes, pricing and task handling until OpenNan offers them as project-free tools (story plan, storyboard, scene
video, copy-video shot detection, shot image edit, copy-video recreate), at which point a host can call them with the
local project's data.

- **Project API client.** `createProjectApi` sends JSON to the opennan.com API with the signed-in key as a bearer and
  turns the error envelope into `ProjectApiError`.
- **Pipeline requests.** `pipelineRequest` builds one step's request (`POST /v1/projects/{id}/story/plan`,
  `/scenes/{scene}/storyboard`, `/scenes/{scene}/videos`, `/scenes/{scene}/copy-video/detections`,
  `/scenes/{scene}/shots/{n}/image-edits`, `/scenes/{scene}/copy-video/recreate`); `checkPipelineRequest` lets through
  only those routes of one project, with each route's own fields.
- **Quotes.** `createQuotes` reads a step's price and hold from `POST /v1/quotes`, cached 60 s per body.
- **Tasks.** `createProjectTasks` submits a step once with an Idempotency-Key, follows the task with long polls of
  `GET /v1/tasks/{id}?wait=50`, and cancels by the server's codes. Nothing is ever retried on its own.
- **Scripts.** `cutScript` cuts plain text into subtitle cues; `parseSrt` / `toSrt` read and write SRT.

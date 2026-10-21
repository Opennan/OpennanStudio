# @opennan/director-client

The OpenNan AI director for OpenNan Studio (phase 9b). OpenNan Community License (as `@opennan/cloud-backend`, whose
API client it uses); runs in browsers and Node.

- **Director turns.** `streamTurn` posts one turn to `POST /v1/projects/{id}/director/turns` and yields its named
  server-sent events (`turn.started`, `turn.thinking`, `message`, `tool.started`, `tool.finished`, `proposal`,
  `project.revision`, `error`, `turn.finished`) as typed objects, parsed by our own reader over the response stream.
  Aborting stops the stream and asks the server to cancel the turn. `listTurns`, `getTurn` and `cancelTurn` read
  and stop turns.
- **Quotes.** `createQuotes` reads a turn's hold and typical price and a project tool's quote from `POST /v1/quotes`,
  cached; an older server answers null and Studio says so.
- **Project tasks.** `createProjectTasks` submits the paid project pipelines (story plan, storyboard, scene video,
  copy-video), follows the task with long polls, cancels by the server's codes and reports the project revision the
  result landed in. Nothing is ever retried on its own.
- **Proposals.** `checkProposalRequest` lets through only the pipeline routes of the open project.
- **Scripts.** `cutScript` cuts plain text into subtitle cues; `parseSrt` / `toSrt` read and write SRT.

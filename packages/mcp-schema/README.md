# @opennan/mcp-schema

Tool names and JSON schemas of the OpenNan Studio MCP server. Apache-2.0.

- `STUDIO_TOOLS`: every MCP tool with its input schema, kind (`read`, `command`, `host`, `capability`), the editor commands it runs, and the provider capability it needs.
- Tool names match the OpenNan editor toolset (`read_timeline`, `edit_timeline_clip`, `split_scene`, ...); `OPENNAN_TOOL_NAMES` lists that toolset and `toolCoverage()` maps every name.
- Field types come from `src/generated/editor-types.ts`, generated from the `@opennan/timeline-core` types (`pnpm --filter @opennan/mcp-schema generate`). Its only runtime dependency is `@opennan/provider-sdk` (Apache-2.0), which owns the capability lists it re-exports.

See `docs/ai-tool-coverage.md` for the full table.

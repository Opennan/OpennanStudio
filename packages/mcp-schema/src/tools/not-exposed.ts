// OpenNan chat tools that only make sense inside the OpenNan chat runtime.
import type { NotExposedTool } from "../types";

export const NOT_EXPOSED_TOOLS: readonly NotExposedTool[] = [
    { name: "ask_user_question", reason: "Chat UI prompt; MCP clients ask their user directly." },
    { name: "request_stronger_model", reason: "Chat model routing inside OpenNan." },
    { name: "delegate_to_specialist", reason: "OpenNan chat agent routing." },
    { name: "read_guide", reason: "OpenNan chat help content." },
    { name: "read_project_data", reason: "Raw OpenNan database rows; read_timeline covers the editor data." },
    { name: "update_project_data", reason: "Raw OpenNan database writes; editor tools cover the editor data." },
];

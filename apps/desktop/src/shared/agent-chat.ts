/** Local CLI chat. Credentials and native conversation ids stay with main/the CLI. */
export const CHAT_PROFILES = ["claude", "codex"] as const;
export type ChatProfile = (typeof CHAT_PROFILES)[number];
export interface ChatMessage {
    id: string;
    role: "user" | "assistant" | "tool";
    text: string;
}
export interface ChatState {
    projectId: string;
    profile: ChatProfile;
    messages: ChatMessage[];
    running: boolean;
    stopping: boolean;
    error: string | null;
}
export interface ChatAvailability {
    profile: ChatProfile;
    installed: boolean;
    subscription: boolean;
    message: string;
}
export interface AgentChatBridge {
    availability(): Promise<ChatAvailability[]>;
    state(projectId: string, profile: ChatProfile): Promise<ChatState>;
    send(projectId: string, profile: ChatProfile, message: string): Promise<void>;
    stop(projectId: string, profile: ChatProfile): Promise<void>;
    reset(projectId: string, profile: ChatProfile): Promise<void>;
    onChanged(listener: (state: ChatState) => void): () => void;
}

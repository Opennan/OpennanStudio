// The AI tab (phase 9b): the AI director's chat, the Storyboards board and the Script to video wizard of a cloud
// project. A local project gets "Save to OpenNan to use the AI director" (nothing is sent); signed out, the phase 8
// Sign in with OpenNan. Every paid thing shows its price before it runs; a turn shows its charge after.
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { isCloudProjectId } from "@opennan/cloud-backend";
import { formatUsdUp, MAX_MESSAGE_CHARS } from "@opennan/director-client";
import { useTimelineMessages } from "@opennan/timeline-react";
import { useAccount, useAccountStatus } from "../account/account-context";
import { SaveToCloudDialog } from "../cloud/save-dialog";
import { useStudioRuntime } from "../platform/runtime-context";
import { BUDGET_CHOICES, type BudgetUsd, type CardView, type DirectorHost, type DirectorState, type ProposalView, type TaskView, type TurnView } from "./director-host";
import { directorErrorText, isTaskLive, priceLineText, taskStatusText, turnStatusText, type DirectorT } from "./director-copy";
import { StoryboardBoard } from "./storyboard-board";
import { ScriptWizard } from "./script-wizard";
import { useDirectorState } from "./use-director";
import "./director.css";

export type DirectorView = "chat" | "storyboards" | "script";

export function DirectorPanel({ projectId, projectName, host }: { projectId: string; projectName: string; host: DirectorHost | null }) {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const { account, openSignIn } = useAccount();
    const status = useAccountStatus(account);
    const [view, setView] = useState<DirectorView>("chat");
    if (!isCloudProjectId(projectId)) return <LocalPrompt projectId={projectId} projectName={projectName} />;
    if (status.state === "signed-in" && !host) return <p className="director director-prompt muted">{t("loading")}</p>;
    if (status.state !== "signed-in" || !host) {
        return (
            <div className="director director-prompt" data-testid="director-signed-out">
                <h2 className="director-prompt-title">{t("signedOutTitle")}</h2>
                <p className="muted">{t("signedOutBody")}</p>
                <button type="button" className="button primary" onClick={() => void openSignIn({ reason: t("title") })}>{t("signIn")}</button>
            </div>
        );
    }
    return (
        <div className="director" data-testid="director-panel">
            <div className="director-views" role="radiogroup" aria-label={t("title")}>
                {(["chat", "storyboards", "script"] as const).map((id) => (
                    <button key={id} type="button" role="radio" aria-checked={view === id} className="director-view" onClick={() => setView(id)}>
                        {t(id === "chat" ? "viewChat" : id === "storyboards" ? "viewStoryboards" : "viewScript")}
                    </button>
                ))}
            </div>
            {view === "chat" && <ChatView host={host} />}
            {view === "storyboards" && <StoryboardBoard host={host} />}
            {view === "script" && <ScriptWizard host={host} />}
        </div>
    );
}

function LocalPrompt({ projectId, projectName }: { projectId: string; projectName: string }) {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const { account, openSignIn } = useAccount();
    const { cloud } = useStudioRuntime();
    const [saving, setSaving] = useState(false);
    return (
        <div className="director director-prompt" data-testid="director-local">
            <SparkIcon large />
            <h2 className="director-prompt-title">{t("localTitle")}</h2>
            <p className="muted">{t("localBody")}</p>
            {cloud && (
                <button
                    type="button" className="button primary"
                    onClick={async () => {
                        if (account.status().state !== "signed-in" && !(await openSignIn({ reason: t("localSave") }))) return;
                        setSaving(true);
                    }}
                >
                    {t("localSave")}
                </button>
            )}
            {saving && <SaveToCloudDialog projectId={projectId} projectName={projectName} onClose={() => setSaving(false)} />}
        </div>
    );
}

function ChatView({ host }: { host: DirectorHost }) {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const state = useDirectorState(host);
    const list = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const turnsKey = state.turns.map((turn) => `${turn.key}:${turn.texts.length}:${turn.cards.length}:${turn.proposals.length}:${turn.status}`).join("|");
    useEffect(() => {
        const el = list.current;
        if (el && stick.current) el.scrollTop = el.scrollHeight;
    }, [turnsKey]);
    const helpId = useId();
    return (
        <div className="director-chat">
            <header className="director-head">
                <h2 className="director-title"><SparkIcon /> {t("title")}</h2>
                <span className="director-price" data-testid="director-price" aria-describedby={helpId} title={t("priceHelp")}>
                    {state.quoteLoaded ? priceLineText(t, state.quote) : " "}
                </span>
                <span id={helpId} className="visually-hidden">{t("priceHelp")}</span>
            </header>
            <div
                ref={list} className="director-messages" data-testid="director-messages" aria-live="polite" aria-relevant="additions text"
                onScroll={(event) => {
                    const el = event.currentTarget;
                    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                    if (el.scrollTop < 24 && state.hasMore && !state.loading) void host.loadOlder();
                }}
            >
                {state.hasMore && (
                    <button type="button" className="button ghost small director-older" disabled={state.loading} onClick={() => void host.loadOlder()}>
                        {state.loading ? t("loading") : t("loadOlder")}
                    </button>
                )}
                {state.turns.length === 0 && !state.loading && (
                    <div className="director-empty">
                        <p>{t("empty")}</p>
                        <p className="muted">{t("emptyExample")}</p>
                    </div>
                )}
                {state.turns.map((turn) => <Turn key={turn.key} turn={turn} host={host} />)}
            </div>
            {state.error && (
                <div className="director-banner" role="alert">
                    <AlertIcon /> <span>{directorErrorText(t, state.error)}</span>
                    <button type="button" className="button ghost small" onClick={() => host.dismissError()}>{t("dismiss")}</button>
                </div>
            )}
            {state.busyElsewhere && !state.running && (
                <div className="director-banner" role="status" data-testid="director-busy">
                    <BusyIcon /> <span>{t("busyElsewhere")}</span>
                    <button type="button" className="button ghost small" onClick={() => void host.stopOther()}>{t("stopIt")}</button>
                </div>
            )}
            <Composer host={host} state={state} />
        </div>
    );
}

function Composer({ host, state }: { host: DirectorHost; state: DirectorState }) {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const [text, setText] = useState("");
    const input = useRef<HTMLTextAreaElement>(null);
    const budgetId = useId();
    const counterId = useId();
    const running = state.running;
    const stopping = running && state.turns.at(-1)?.stopping;
    const send = async () => {
        const message = text.trim();
        if (!message || running || message.length > MAX_MESSAGE_CHARS) return;
        setText("");
        const sent = await host.send(message);
        if (!sent) setText((current) => current || message);
        input.current?.focus();
    };
    const onKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        // The editor's own shortcuts never see typing here.
        event.stopPropagation();
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
        }
    };
    const over = text.length > MAX_MESSAGE_CHARS;
    return (
        <div className="director-composer">
            <div className="director-input-row">
                <textarea
                    ref={input} className="input director-input" rows={2} value={text} aria-label={t("composerLabel")} placeholder={t("composerPlaceholder")}
                    aria-describedby={counterId} aria-invalid={over || undefined} onChange={(event) => setText(event.target.value)} onKeyDown={onKey}
                />
                {running
                    ? <button type="button" className="button small director-send" onClick={() => void host.stop()} disabled={Boolean(stopping)}><StopIcon /> {stopping ? t("stopping") : t("stop")}</button>
                    : <button type="button" className="button primary small director-send" onClick={() => void send()} disabled={!text.trim() || over || Boolean(state.busyElsewhere)}>{t("send")}</button>}
            </div>
            <div className="director-composer-meta">
                <label className="director-budget" htmlFor={budgetId}>
                    <span>{t("budgetLabel")}</span>
                    <select id={budgetId} className="input director-budget-select" value={state.budgetUsd} title={t("budgetNote")} onChange={(event) => host.setBudget(Number(event.target.value) as BudgetUsd)}>
                        {BUDGET_CHOICES.map((usd) => <option key={usd} value={usd}>{usd === 0 ? t("budgetAsk") : t("budgetUpTo", { usd: `$${usd}` })}</option>)}
                    </select>
                </label>
                <span id={counterId} className={over ? "director-count director-count-over" : "director-count"}>{text.length > MAX_MESSAGE_CHARS * 0.8 ? t("charCount", { count: text.length.toLocaleString("en-US"), max: MAX_MESSAGE_CHARS.toLocaleString("en-US") }) : ""}</span>
            </div>
        </div>
    );
}

function Turn({ turn, host }: { turn: TurnView; host: DirectorHost }) {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const status = turnStatusText(t, turn);
    const live = turn.status === "sending" || turn.status === "running";
    return (
        <article className="director-turn" data-testid="director-turn" data-status={turn.status}>
            <div className="director-bubble director-you">
                <span className="director-who">{t("you")}</span>
                <p className="director-text">{turn.message}</p>
            </div>
            <div className="director-bubble director-ai">
                <span className="director-who"><SparkIcon /> {t("ai")}</span>
                {turn.texts.map((text, i) => <p key={i} className="director-text">{text}</p>)}
                {turn.cards.filter((card) => !card.proposal || !turn.proposals.some((p) => p.callId === card.callId)).map((card) => <ToolCardView key={card.callId} card={card} host={host} />)}
                {turn.proposals.map((proposal) => <ProposalCard key={proposal.callId} proposal={proposal} turn={turn} host={host} />)}
                {live && turn.thinking && <p className="director-typing" role="status"><span className="director-dots" aria-hidden="true"><i /><i /><i /></span> {turn.cards.some((c) => !c.done) ? t("working") : t("thinking")}</p>}
                {turn.error && <p className="director-error" role="alert"><AlertIcon /> {directorErrorText(t, turn.error)}</p>}
                {(status || turn.step) && (
                    <div className="director-turn-foot">
                        {status && <span className="director-charge" data-testid="director-charge">{status}</span>}
                        {turn.step && (
                            <button type="button" className="button ghost small director-undo" disabled={turn.step.undone} title={t("undoAiTitle")} onClick={() => void host.undoTurn(turn.key)}>
                                <UndoIcon /> {turn.step.undone ? t("undoneAi") : t("undoAi")}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </article>
    );
}

function ToolCardView({ card, host }: { card: CardView; host: DirectorHost }) {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const state = !card.done ? "running" : card.ok ? "ok" : "failed";
    return (
        <div className="director-card" data-testid="director-card" data-state={state}>
            <div className="director-card-head">
                {state === "running" ? <Spinner /> : state === "ok" ? <CheckIcon /> : <AlertIcon />}
                <span className="director-card-label">{card.label}</span>
                <span className="director-card-state">{state === "running" ? t("cardRunning") : card.proposal ? t("cardProposed") : state === "ok" ? t("cardDone") : t("cardFailed")}</span>
            </div>
            {card.done && (card.summary || card.failure) && <p className="director-card-summary">{card.ok ? card.summary : card.failure || card.summary}{card.revision !== undefined ? ` · ${t("cardRevision", { revision: card.revision })}` : ""}</p>}
            {card.task && <TaskLine task={card.task} host={host} />}
        </div>
    );
}

function ProposalCard({ proposal, turn, host }: { proposal: ProposalView; turn: TurnView; host: DirectorHost }) {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const price = formatUsdUp(proposal.quote.holdUsd);
    const args = shownArgs(proposal.args);
    return (
        <div className="director-card director-proposal" data-testid="director-proposal" data-state={proposal.state}>
            <div className="director-card-head">
                <CoinIcon />
                <span className="director-card-label">{proposal.label}</span>
                <span className="director-card-state">{t("proposalPrice", { usd: price })}</span>
            </div>
            {args.length > 0 && <p className="director-card-summary">{args.map(([k, v]) => `${k}: ${v}`).join(" · ")}</p>}
            {proposal.state === "blocked" && <p className="director-error"><AlertIcon /> {t("proposalBlocked")}</p>}
            {proposal.state === "expired" && <p className="director-error" data-testid="proposal-expired"><AlertIcon /> {t("proposalExpired")}</p>}
            {proposal.state === "ran" && <p className="director-card-summary" data-testid="proposal-ran"><CheckIcon /> {t("proposalRan")}</p>}
            {proposal.error && proposal.state !== "blocked" && <p className="director-error" role="alert"><AlertIcon /> {directorErrorText(t, proposal.error)}</p>}
            {proposal.task ? <TaskLine task={proposal.task} host={host} onRetry={proposal.state === "failed" ? () => void host.runProposal(turn.key, proposal.callId) : undefined} />
                : proposal.state !== "blocked" && proposal.state !== "expired" && proposal.state !== "ran" && (
                    <div className="director-card-actions">
                        <button type="button" className="button primary small" disabled={proposal.state === "checking"} onClick={() => void host.runProposal(turn.key, proposal.callId)}>
                            {proposal.state === "checking" ? t("proposalChecking") : t("proposalRun", { usd: price })}
                        </button>
                    </div>
                )}
        </div>
    );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A proposal's arguments in plain words: short values only, never ids. */
export function shownArgs(args: Record<string, unknown>): Array<[string, string]> {
    return Object.entries(args)
        .filter(([key, value]) => !/(^|_)ids?$/.test(key) && (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.length <= 80 && !UUID.test(value) && !/^https?:/.test(value))))
        .slice(0, 4)
        .map(([key, value]) => [key.replace(/_/g, " "), String(value)]);
}

export function TaskLine({ task, host, onRetry }: { task: TaskView; host: DirectorHost; onRetry?: (() => void) | undefined }) {
    const t = useTimelineMessages("aiDirector") as DirectorT;
    const live = isTaskLive(task);
    return (
        <div className="director-task" data-testid="director-task" data-status={task.status}>
            {live ? <Spinner /> : task.status === "succeeded" ? <CheckIcon /> : <AlertIcon />}
            <span className="director-task-text">{taskStatusText(t, task)}</span>
            {live && task.holdUsd !== undefined && <span className="director-task-hold muted">{t("taskHolds", { usd: formatUsdUp(task.holdUsd) })}</span>}
            {live && task.id && <button type="button" className="button ghost small" onClick={() => void host.cancelTask(task.id!)}>{t("cancel")}</button>}
            {!live && (task.status === "failed" || task.status === "cancelled") && onRetry && <button type="button" className="button ghost small" onClick={onRetry}>{t("retry")}</button>}
            {task.cancelMessage && <span className="director-task-note muted">{task.cancelMessage}</span>}
            {live && typeof task.progress === "number" && <span className="director-progress" aria-hidden="true"><span style={{ width: `${Math.round(task.progress * 100)}%` }} /></span>}
        </div>
    );
}

// ── icons (currentColor; states always come with words) ──
const base = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, focusable: false };
export function SparkIcon({ large }: { large?: boolean }) {
    return <svg {...base} width={large ? 28 : 14} height={large ? 28 : 14}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 3v4M21 5h-4" /></svg>;
}
export function CheckIcon() {
    return <svg {...base}><path d="M20 6 9 17l-5-5" /></svg>;
}
export function AlertIcon() {
    return <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></svg>;
}
function BusyIcon() {
    return <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
}
function StopIcon() {
    return <svg {...base} width={12} height={12}><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" /></svg>;
}
function UndoIcon() {
    return <svg {...base}><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>;
}
function CoinIcon() {
    return <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.9 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6v2M12 16v2" /></svg>;
}
export function Spinner() {
    return <span className="director-spinner" aria-hidden="true" />;
}

// Settings → AI providers (spec §5.4, phase 8): the OpenNan card (sign in, account, "Use OpenNan by default"),
// the other providers with Add provider (OpenNan API key, bring-your-own keys, the on-device provider), and which
// provider runs each capability. opennan.* rows are locked to OpenNan (spec §2.1).
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { CloudStorageSection } from "../cloud/cloud-storage-section";
import { MediaCacheSection } from "../cloud/media-cache-section";
import type { OpenCapability, ProviderCapability, ProviderModel } from "@opennan/provider-sdk";
import { AccountChip } from "../account/account-chip";
import { useAccount } from "../account/account-context";
import type { ProviderKeyId } from "../account/account-types";
import { Avatar } from "../account/avatar";
import { formatCredits } from "../account/format-credits";
import { useStudioRuntime } from "../platform/runtime-context";
import { routeHref } from "../routing/routes";
import { BrandMark } from "../ui/brand-mark";
import { Dialog } from "../ui/dialog";
import { ChevronIcon, LockIcon } from "../ui/icons";
import { CAPABILITY_LABELS, ROUTING_GROUPS } from "./routing-groups";
import "./settings.css";

type AddDialog = { kind: "opennan-key" } | { kind: "provider-key"; id: ProviderKeyId; name: string } | { kind: "local" } | null;

function useRegistryVersion() {
    const { providers } = useStudioRuntime();
    return useSyncExternalStore((listener) => providers.subscribe(listener), () => providers.version());
}

function useRouting() {
    const { providerSettings } = useStudioRuntime();
    return useSyncExternalStore((listener) => providerSettings.subscribe(listener), () => providerSettings.routing());
}

export function ProviderSettingsScreen() {
    const { ui, platform, mediaCache } = useStudioRuntime();
    const [dialog, setDialog] = useState<AddDialog>(null);
    return (
        <div className="settings">
            <header className="settings-header">
                <a className="button ghost" href={routeHref({ name: "projects" })}>Projects</a>
                <div className="topbar-spacer" />
                <AccountChip />
            </header>
            <main className="settings-main">
                <h1>AI providers</h1>
                <p className="muted">
                    {platform === "desktop"
                        ? "Editing, preview, and export need no account and no connection. Providers add AI tools such as video, image, voice, and music generation."
                        : "Editing, preview, and export need no account. Once the page is open, editing and preview work without a connection; the first export downloads the video encoder (about 32 MB) and keeps it in this browser. Providers add AI tools such as video, image, voice, and music generation."}
                </p>
                <OpenNanCard />
                <OtherProviders onAdd={setDialog} />
                <RoutingTable />
                {mediaCache && <MediaCacheSection cache={mediaCache} />}
                {ui.SettingsAddons && <ui.SettingsAddons />}
            </main>
            {dialog?.kind === "opennan-key" && <OpenNanKeyDialog onClose={() => setDialog(null)} />}
            {dialog?.kind === "provider-key" && <ProviderKeyDialog id={dialog.id} name={dialog.name} onClose={() => setDialog(null)} />}
            {dialog?.kind === "local" && <LocalProviderDialog onClose={() => setDialog(null)} />}
        </div>
    );
}

function OpenNanCard() {
    const { providerSettings } = useStudioRuntime();
    const { account, status, openSignIn } = useAccount();
    const routing = useRouting();
    const titleId = useId();
    const signedIn = status.state === "signed-in";
    const info = signedIn ? status.account : null;
    const toggle = () => void providerSettings.setRouting({ ...routing, opennanDefault: !routing.opennanDefault });
    return (
        <section className="provider-card opennan-card" aria-labelledby={titleId}>
            <div className="provider-card-head">
                <span className="provider-logo"><BrandMark /></span>
                <div className="provider-card-title">
                    <h2 id={titleId}>OpenNan</h2>
                    <p className="muted small">Video, image, voice, music, storyboards, and story tools on opennan.com. Uses your OpenNan credits.</p>
                </div>
                {routing.opennanDefault && <span className="provider-badge">Default for all AI tools</span>}
            </div>
            {signedIn ? (
                <div className="provider-account">
                    <Avatar account={info} size={32} />
                    <span className="provider-account-line">
                        <strong>{info?.email ?? "Signed in"}</strong>
                        {info && info.balanceUsd !== null && <span className="muted small">Credits {formatCredits(info.balanceUsd)}</span>}
                    </span>
                    <button type="button" className="button small" onClick={() => account.openConsole("billing")}>Buy credits</button>
                    <button type="button" className="button ghost small" onClick={() => void account.signOut()}>Sign out</button>
                </div>
            ) : (
                <div className="provider-account">
                    <button type="button" className="button primary provider-signin" onClick={() => void openSignIn({})}>
                        <BrandMark className="provider-signin-mark" />Sign in with OpenNan
                    </button>
                    <span className="muted small">One click in your browser. No password in Studio.</span>
                </div>
            )}
            {signedIn && <CloudStorageSection />}
            <div className="provider-switch-row">
                <button type="button" role="switch" aria-checked={routing.opennanDefault} aria-labelledby={`${titleId}-switch`} className="switch" onClick={toggle}>
                    <span className="switch-thumb" />
                </button>
                <span>
                    <span id={`${titleId}-switch`} className="provider-switch-label">Use OpenNan by default</span>
                    <span className="muted small">{routing.opennanDefault ? "OpenNan runs every AI tool it offers unless you pick another provider below." : "AI tools use the providers you pick below; OpenNan runs only its own story tools."}</span>
                </span>
            </div>
        </section>
    );
}

function OtherProviders({ onAdd }: { onAdd(dialog: AddDialog): void }) {
    const { providers, providerSettings, platform } = useStudioRuntime();
    useRegistryVersion();
    useSyncExternalStore((listener) => providerSettings.subscribe(listener), () => providerSettings.keys().map((k) => `${k.id}:${k.set}`).join());
    const installed = providers.providers().filter((p) => p.info.id !== "opennan");
    const keys = providerSettings.keys();
    return (
        <section className="provider-section" aria-labelledby="other-providers">
            <div className="provider-section-head">
                <h2 id="other-providers">Other providers</h2>
                <AddProviderMenu onAdd={onAdd} keys={keys} desktop={platform === "desktop"} />
            </div>
            <ul className="provider-list" aria-label="Providers">
                <li className="provider-row">
                    <div>
                        <h3>This device</h3>
                        <p className="muted small">Timeline editing, preview, and MP4 export {platform === "desktop" ? "on this computer" : "in your browser"}.</p>
                    </div>
                    <span className="provider-status" data-state="active">Active</span>
                </li>
                {installed.map((provider) => (
                    <li key={provider.info.id} className="provider-row" data-provider={provider.info.id}>
                        <div>
                            <h3>{provider.info.name}</h3>
                            <p className="muted small">{provider.info.capabilities.map((c) => CAPABILITY_LABELS[c]).join(" · ")}</p>
                        </div>
                        <span className="provider-status" data-state="active">Ready</span>
                    </li>
                ))}
                {keys.filter((k) => k.set && !installed.some((p) => p.info.id === k.id)).map((k) => (
                    <li key={k.id} className="provider-row">
                        <div>
                            <h3>{k.name}</h3>
                            <p className="muted small">Key saved. Restart Studio if the provider does not appear.</p>
                        </div>
                        <button type="button" className="button ghost small" onClick={() => void providerSettings.removeKey(k.id)}>Remove key</button>
                    </li>
                ))}
                {keys.filter((k) => k.set && installed.some((p) => p.info.id === k.id)).map((k) => (
                    <li key={`${k.id}-key`} className="provider-row provider-row-sub">
                        <p className="muted small">{k.name} key saved on this {platform === "desktop" ? "computer" : "browser"}.</p>
                        <button type="button" className="button ghost small" onClick={() => void providerSettings.removeKey(k.id)}>Remove key</button>
                    </li>
                ))}
            </ul>
        </section>
    );
}

function AddProviderMenu({ onAdd, keys, desktop }: { onAdd(dialog: AddDialog): void; keys: Array<{ id: ProviderKeyId; name: string }>; desktop: boolean }) {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
        const onDown = (event: MouseEvent) => {
            if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [open]);
    const pick = (dialog: AddDialog) => {
        setOpen(false);
        onAdd(dialog);
    };
    return (
        <div className="account-chip-wrap">
            <button ref={trigger} type="button" className="button small" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                Add provider <ChevronIcon />
            </button>
            {open && (
                <div
                    ref={menu}
                    className="account-menu add-provider-menu"
                    role="menu"
                    aria-label="Add provider"
                    onKeyDown={(event) => {
                        const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
                        const index = items.indexOf(document.activeElement as HTMLElement);
                        if (event.key === "Escape") {
                            event.stopPropagation();
                            setOpen(false);
                            trigger.current?.focus();
                        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                            event.preventDefault();
                            items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
                        }
                    }}
                >
                    {keys.map((k) => (
                        <button key={k.id} type="button" role="menuitem" className="account-menu-item add-provider-item" onClick={() => pick({ kind: "provider-key", id: k.id, name: k.name })}>
                            <strong>{k.name}</strong><span className="muted small">Bring your own key</span>
                        </button>
                    ))}
                    {desktop && (
                        <button type="button" role="menuitem" className="account-menu-item add-provider-item" onClick={() => pick({ kind: "local" })}>
                            <strong>On this device</strong><span className="muted small">Auto captions with whisper.cpp, free and offline</span>
                        </button>
                    )}
                    <button type="button" role="menuitem" className="account-menu-item add-provider-item" onClick={() => pick({ kind: "opennan-key" })}>
                        <strong>OpenNan API key</strong><span className="muted small">Advanced: paste a key from opennan.com</span>
                    </button>
                </div>
            )}
        </div>
    );
}

function RoutingTable() {
    const { providers, providerSettings } = useStudioRuntime();
    const { status } = useAccount();
    const routing = useRouting();
    useRegistryVersion();
    const all = providers.providers();
    const choose = (capability: OpenCapability, providerId: string) => {
        const overrides = { ...routing.overrides };
        if (providerId) overrides[capability] = providerId;
        else delete overrides[capability];
        void providerSettings.setRouting({ ...routing, overrides });
    };
    return (
        <section className="provider-section" aria-labelledby="routing-title">
            <div className="provider-section-head">
                <h2 id="routing-title">Which provider runs each tool</h2>
            </div>
            {ROUTING_GROUPS.map((group) => (
                <div key={group.id} className="routing-group">
                    <h3 className="routing-group-title">{group.title}</h3>
                    <ul className="routing-list">
                        {group.capabilities.map((capability: ProviderCapability) => {
                            const label = CAPABILITY_LABELS[capability];
                            const offering = all.filter((p) => p.info.capabilities.includes(capability));
                            const routed = providers.route(capability);
                            return (
                                <li key={capability} className="routing-row" data-capability={capability}>
                                    <span className="routing-label">{label}</span>
                                    {group.locked ? (
                                        <span className="routing-locked">
                                            <LockIcon />OpenNan only{status.state !== "signed-in" && <span className="muted small"> · sign in to use</span>}
                                        </span>
                                    ) : (
                                        <select
                                            className="text-input routing-select"
                                            aria-label={`Provider for ${label}`}
                                            value={routing.overrides[capability as OpenCapability] ?? ""}
                                            disabled={offering.length === 0}
                                            onChange={(event) => choose(capability as OpenCapability, event.target.value)}
                                        >
                                            <option value="">{offering.length === 0 ? "No provider" : `Automatic · ${routed?.info.name ?? "none"}`}</option>
                                            {offering.map((p) => <option key={p.info.id} value={p.info.id}>{p.info.name}</option>)}
                                        </select>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ))}
        </section>
    );
}

function OpenNanKeyDialog({ onClose }: { onClose(): void }) {
    const { account } = useAccount();
    const [key, setKey] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const noteId = useId();
    const connect = async () => {
        setBusy(true);
        setError(null);
        try {
            await account.connectWithKey(key);
            setKey("");
            onClose();
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog title="OpenNan API key" onClose={onClose} describedBy={noteId}>
            <p id={noteId} className="muted small" style={{ margin: 0 }}>
                For scripts and shared machines. Sign in with OpenNan is easier: it creates a key for this device and revokes it when you sign out.
                Create a key at {account.consoleOrigin.replace(/^https?:\/\//, "")}/console/keys.
            </p>
            <label className="field">
                <span>API key</span>
                <input className="text-input" type="password" autoComplete="off" spellCheck={false} placeholder="sk-…" value={key} data-autofocus onChange={(event) => setKey(event.target.value)} />
            </label>
            {error && <p className="error-text small" role="alert">{error}</p>}
            <div className="dialog-footer">
                <button type="button" className="button ghost" onClick={onClose}>Cancel</button>
                <button type="button" className="button primary" disabled={!key.trim() || busy} onClick={() => void connect()}>{busy ? "Checking…" : "Connect"}</button>
            </div>
        </Dialog>
    );
}

function ProviderKeyDialog({ id, name, onClose }: { id: ProviderKeyId; name: string; onClose(): void }) {
    const { providerSettings, platform } = useStudioRuntime();
    const [key, setKey] = useState("");
    const [error, setError] = useState<string | null>(null);
    const save = async () => {
        setError(null);
        try {
            await providerSettings.setKey(id, key);
            setKey("");
            onClose();
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        }
    };
    return (
        <Dialog title={`${name} key`} onClose={onClose}>
            <p className="muted small" style={{ margin: 0 }}>
                {name} bills you directly. The key stays {platform === "desktop" ? "on this computer, encrypted by the system keychain" : "in this browser"} and is sent only to {name}.
            </p>
            <label className="field">
                <span>API key</span>
                <input className="text-input" type="password" autoComplete="off" spellCheck={false} value={key} data-autofocus onChange={(event) => setKey(event.target.value)} />
            </label>
            {error && <p className="error-text small" role="alert">{error}</p>}
            <div className="dialog-footer">
                <button type="button" className="button ghost" onClick={onClose}>Cancel</button>
                <button type="button" className="button primary" disabled={!key.trim()} onClick={() => void save()}>Save key</button>
            </div>
        </Dialog>
    );
}

function LocalProviderDialog({ onClose }: { onClose(): void }) {
    const { providers, capabilityNote } = useStudioRuntime();
    const local = providers.get("local");
    const [models, setModels] = useState<ProviderModel[]>([]);
    useEffect(() => {
        void local?.audio?.models?.("audio.transcribe").then(setModels).catch(() => undefined);
    }, [local]);
    return (
        <Dialog title="On this device" onClose={onClose}>
            {local ? (
                <>
                    <p className="muted small" style={{ margin: 0 }}>Auto captions run on this computer with whisper.cpp. Free, offline, nothing is uploaded. A model downloads once on first use.</p>
                    <ul className="provider-list" aria-label="Whisper models">
                        {models.map((m) => (
                            <li key={m.id} className="provider-row">
                                <span>{m.label}</span>
                                <span className="provider-status" data-state={m.installed ? "active" : undefined}>{m.installed ? "Downloaded" : "Downloads on first use"}</span>
                            </li>
                        ))}
                    </ul>
                </>
            ) : (
                <p className="captions-unavailable" role="note">{capabilityNote?.("audio.transcribe") ?? "On-device transcription is not available in this build."}</p>
            )}
            <div className="dialog-footer">
                <button type="button" className="button primary" onClick={onClose}>Done</button>
            </div>
        </Dialog>
    );
}

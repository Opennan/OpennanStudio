// The fake OpenNan server for the web e2e suite (@opennan/provider-opennan/testing) on the port the e2e build
// points at (vite.config.ts), and small helpers for its control endpoints.
import { startFakeOpenNan, type FakeOpenNan, type FakeOpenNanState } from "@opennan/provider-opennan/testing";

export const FAKE_OPENNAN_PORT = 4320;
export const FAKE_OPENNAN = `http://127.0.0.1:${FAKE_OPENNAN_PORT}`;

export function startE2eFakeOpenNan(): Promise<FakeOpenNan> {
    return startFakeOpenNan({ port: FAKE_OPENNAN_PORT, intervalSeconds: 3 });
}

export async function fakeControl(path: string): Promise<void> {
    const response = await fetch(`${FAKE_OPENNAN}/__test/${path}`, { method: "POST" });
    if (!response.ok) throw new Error(`fake OpenNan ${path}: ${response.status}`);
}

export async function fakeState(): Promise<FakeOpenNanState> {
    return (await fetch(`${FAKE_OPENNAN}/__test/state`)).json() as Promise<FakeOpenNanState>;
}

// Hashes a file off the page's main thread (SHA-256 streamed: a 1 GB video is never all in memory).
import { hashBlob } from "@opennan/cloud-backend";

self.onmessage = async (event: MessageEvent<{ id: number; blob: Blob }>) => {
    const { id, blob } = event.data;
    try {
        self.postMessage({ id, hash: await hashBlob(blob) });
    } catch (error) {
        self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
};

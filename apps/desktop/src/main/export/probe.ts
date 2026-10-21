// Duration probes for imported and agent-uploaded media, with the same input guards the export runner uses
// (local protocols only, plain media demuxers only): a file named clip.mp4 whose content is an ffconcat, DASH,
// or other manifest must not make ffprobe open further files or URLs.
import { LOCAL_PROTOCOLS, MEDIA_DEMUXERS, probeFile } from "@opennan/export/node";

export const PROBE_GUARDS = ["-protocol_whitelist", LOCAL_PROTOCOLS, "-format_whitelist", MEDIA_DEMUXERS];

export function createGuardedProbe(ffprobePath: string, probe = probeFile): (file: string) => Promise<{ durationSeconds?: number } | null> {
    return (file) => probe(ffprobePath, file, undefined, PROBE_GUARDS);
}

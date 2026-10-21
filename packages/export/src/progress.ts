// Encode progress from ffmpeg output: `-progress` key=value lines (native) or log lines (ffmpeg.wasm).

/** Seconds of output written so far, or null when the line carries no time. */
export function parseProgressSeconds(line: string): number | null {
    const us = line.match(/^out_time_us=(\d+)/);
    if (us) return Number(us[1]) / 1e6;
    const clock = line.match(/(?:^out_time=|\btime=)(-?\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (clock) {
        const seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
        return seconds >= 0 ? seconds : null;
    }
    return null;
}

export function progressRatio(seconds: number, duration: number): number {
    return duration > 0 ? Math.max(0, Math.min(1, seconds / duration)) : 0;
}

// Helpers for committing timeline clip creates/updates from command-style editing actions.
export interface TimelineClipCreateInput {
  startTime: number;
  endTime: number;
  [key: string]: unknown;
}

export interface TimelineClipCreateRunner<TClip = unknown> {
  createClip?: (input: TimelineClipCreateInput) => Promise<TClip | null>;
  createClips?: (inputs: TimelineClipCreateInput[]) => Promise<(TClip | null)[]>;
}

export interface TimelineClipUpdateCommit {
  clipId: string;
  startTime: number;
  endTime: number;
  trackType?: string;
  trackIndex?: number;
  trimStart?: number | null;
  trimEnd?: number | null;
  locked?: boolean;
  volume?: number;
  audioPan?: number;
  audioPitch?: number;
  audioEq?: string;
  audioDenoise?: boolean;
  audioNormalize?: boolean;
  playbackSpeed?: number;
  speedRamp?: string;
  reversePlayback?: boolean;
  freezeFrame?: boolean;
  fadeInDuration?: number;
  fadeOutDuration?: number;
  transitionType?: string;
  transitionDuration?: number;
  opacity?: number;
  scale?: number;
  positionX?: number;
  positionY?: number;
  horizontalFlip?: boolean;
  verticalFlip?: boolean;
  cropLeft?: number;
  cropRight?: number;
  cropTop?: number;
  cropBottom?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  visualFilter?: string;
  filterIntensity?: number | null;
  adjustmentsJson?: string | null;
  motionPreset?: string;
  blurStrength?: number;
  chromaKeyEnabled?: boolean;
  chromaKeyColor?: string;
  chromaKeySimilarity?: number;
  chromaKeyBlend?: number;
  blendMode?: string;
  mosaicStrength?: number;
  rotationDegrees?: number;
  keyframesJson?: string | null;
  textStyle?: string | null;
}

export interface TimelineClipUpdateRunner<TClip = unknown> {
  updateClip?: (clipId: string, input: Omit<TimelineClipUpdateCommit, "clipId">) => Promise<TClip | null>;
  updateClips?: (commits: TimelineClipUpdateCommit[]) => Promise<void>;
}

export interface TimelineClipSplitRunner<TClip = unknown> {
  splitClip?: (clipId: string, splitTime: number) => Promise<TClip | null>;
  splitClips?: (clipIds: string[], splitTime: number) => Promise<(TClip | null)[] | void>;
}

export interface TimelineClipCommand {
  creates: TimelineClipCreateInput[];
  updates: TimelineClipUpdateCommit[];
  deleteIds: string[];
  description?: string;
}

export interface TimelineClipCommandRunner<TClip = unknown> {
  createClip?: (input: TimelineClipCreateInput) => Promise<TClip | null>;
  createClips?: (inputs: TimelineClipCreateInput[]) => Promise<(TClip | null)[]>;
  updateClip?: (clipId: string, input: Omit<TimelineClipUpdateCommit, "clipId">) => Promise<TClip | null>;
  updateClips?: (commits: TimelineClipUpdateCommit[]) => Promise<void>;
  deleteClip?: (clipId: string) => Promise<boolean>;
  deleteClips?: (clipIds: string[]) => Promise<void>;
  clipCommand?: (command: TimelineClipCommand) => Promise<(TClip | null)[]>;
}

export async function commitTimelineClipCommand<TClip>(
  command: TimelineClipCommand,
  runner: TimelineClipCommandRunner<TClip>,
): Promise<(TClip | null)[]> {
  const hasCreates = command.creates.length > 0;
  const hasUpdates = command.updates.length > 0;
  const hasDeletes = command.deleteIds.length > 0;
  if (!hasCreates && !hasUpdates && !hasDeletes) return [];

  if (runner.clipCommand) return runner.clipCommand(command);

  await commitTimelineClipUpdates(command.updates, runner);
  if (command.deleteIds.length > 0) {
    if (runner.deleteClips) {
      await runner.deleteClips(command.deleteIds);
    } else {
      const deleteClip = runner.deleteClip;
      if (!deleteClip) throw new Error("Timeline clip command runner is missing deleteClip/deleteClips"); // i18n-ignore
      await Promise.all(command.deleteIds.map((id) => deleteClip(id)));
    }
  }
  return commitTimelineClipCreates(command.creates, runner);
}

export async function commitTimelineClipCreates<TClip>(
  inputs: TimelineClipCreateInput[],
  runner: TimelineClipCreateRunner<TClip>,
): Promise<(TClip | null)[]> {
  if (inputs.length === 0) return [];
  if (runner.createClips) {
    return runner.createClips(inputs);
  }
  const createClip = runner.createClip;
  if (!createClip) throw new Error("Timeline clip create runner is missing createClip/createClips"); // i18n-ignore

  return Promise.all(inputs.map((input) => createClip(input)));
}

export async function commitTimelineClipSplits<TClip>(
  clipIds: string[],
  splitTime: number,
  runner: TimelineClipSplitRunner<TClip>,
): Promise<(TClip | null)[]> {
  if (clipIds.length === 0) return [];
  if (runner.splitClips) {
    return await runner.splitClips(clipIds, splitTime) ?? [];
  }
  const splitClip = runner.splitClip;
  if (!splitClip) throw new Error("Timeline clip split runner is missing splitClip/splitClips"); // i18n-ignore

  return Promise.all(clipIds.map((clipId) => splitClip(clipId, splitTime)));
}

export async function commitTimelineClipUpdates<TClip>(
  commits: TimelineClipUpdateCommit[],
  runner: TimelineClipUpdateRunner<TClip>,
): Promise<void> {
  if (commits.length === 0) return;
  if (runner.updateClips) {
    await runner.updateClips(commits);
    return;
  }
  const updateClip = runner.updateClip;
  if (!updateClip) throw new Error("Timeline clip update runner is missing updateClip/updateClips"); // i18n-ignore

  await Promise.all(
    commits.map(({ clipId, ...input }) => updateClip(clipId, input)),
  );
}

// @opennan/export/node: native ffmpeg runner (desktop main process, CLI, golden tests).
export { createNodeRunner, type NodeRunnerOptions } from "./runner";
export {
    createSourcePolicy, jobFilePath, LOCAL_PROTOCOLS, NETWORK_PROTOCOLS, MEDIA_DEMUXERS, type SourcePolicy, type SourcePolicyOptions,
} from "./source-policy";
export {
    runProcess, parseFfmpegMajorVersion, ffmpegMajorVersion, listEncoders, encoderWorks, chooseWorkingEncoder,
    type ProcessResult, type RunProcessOptions,
} from "./ffmpeg-binary";
export { probeFile } from "./prober";
export { renderGlPasses, compositeGlPasses } from "./gl-passes";

// Events owned by phase 2b (voice worker): e.g. call state, worker health. Add members to this
// union; keep `never` until the first one exists.
export type VoiceEvent = never;

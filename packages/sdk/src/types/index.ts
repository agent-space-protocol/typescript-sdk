/**
 * Types generated from the specification's `schema.json`, and validation against it.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import schemaJson from "../../schema/schema.json" with { type: "json" };

export * from "./generated.ts";

/** The JSON Schema of every message, as published by the specification. */
export const schema: Record<string, any> = schemaJson;

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;
const ajv = new Ajv2020({ strict: false, allErrors: false });
addFormats(ajv);
ajv.addSchema(schemaJson, "asp");
const cache = new Map<string, ValidateFunction>();

/** Validates a value against one definition of the schema. Returns a sentence on failure. */
export function validate(definition: string, value: unknown): string | undefined {
  let v = cache.get(definition);
  if (!v) {
    v = ajv.getSchema(`asp#/$defs/${definition}`);
    if (!v) throw new Error(`no definition named ${definition}`);
    cache.set(definition, v);
  }
  if (v(value)) return undefined;
  const e = v.errors?.[0];
  if (!e) return "does not match the schema";
  return `${e.instancePath || "message"} ${e.message ?? "is invalid"}`.trim();
}

/** Message types a participant sends, and the schema definition of each. */
export const PARTICIPANT_MESSAGES: Record<string, string> = {
  hello: "ParticipantHello",
  join: "Join",
  leave: "Leave",
  observe: "Observe",
  subscribe: "Subscribe",
  act: "Act",
  edit: "Edit",
  cancel: "Cancel",
  record: "RecordRequest",
  vocabulary: "VocabularyRequest",
  blob: "BlobRequest",
  stream: "StreamRequest",
  consent: "ConsentMessage",
  snapshot: "SnapshotRequest",
  restore: "RestoreRequest",
  episode: "EpisodeRequest",
  score: "ScoreRequest",
  pause: "PauseRequest",
  resume: "ResumeRequest",
  sense: "SenseRequest",
  views: "ViewsRequest",
  offer: "Offer",
  take: "Take",
};

/** Message types a space sends, and the schema definition of each. */
export const SPACE_MESSAGES: Record<string, string> = {
  hello: "SpaceHello",
  observation: "Observation",
  subscribed: "Subscribed",
  accepted: "Accepted",
  progress: "Progress",
  waiting: "Waiting",
  outcome: "Outcome",
  event: "EventMessage",
  entries: "Entries",
  vocabulary: "VocabularyMessage",
  blob: "BlobMessage",
  frame: "Frame",
  error: "ErrorMessage",
};

/** The capability each capability message needs. Except for `edit`, a core message, it is also the message's part. */
export const MESSAGE_CAPABILITY: Record<string, string> = {
  edit: "edit",
  stream: "forms",
  consent: "consent",
  snapshot: "snapshot",
  restore: "snapshot",
  episode: "episode",
  score: "episode",
  pause: "pause",
  resume: "pause",
  sense: "senses",
  views: "views",
  offer: "doors",
  take: "doors",
};

/** The parts of the protocol other than the core; each belongs to the capability of the same name. */
export const CAPABILITY_PARTS = ["forms", "snapshot", "episode", "consent", "pause", "senses", "views", "doors"] as const;

/** The reasons defined by the protocol. */
export const PROTOCOL_REASONS = [
  "unsupported",
  "forbidden",
  "malformed",
  "stale",
  "constraint",
  "deadline",
  "closed",
  "restarted",
  "expired",
] as const;

/** The five final outcomes. */
export const ENDS = ["done", "refused", "failed", "cancelled", "unknown"] as const;

/** The versions of each part this SDK implements. */
export const SDK_PARTS: { core: number[]; [part: string]: number[] } = {
  core: [0],
  forms: [0],
  snapshot: [0],
  episode: [0],
  consent: [0],
  pause: [0],
  senses: [0],
  views: [0],
  doors: [0],
};

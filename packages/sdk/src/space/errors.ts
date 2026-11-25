/**
 * What a law throws to end an action other than `done`. A handler that returns ends it as `done`.
 */
import type { Effect, JSONValue } from "../types/index.ts";

/** Ends the action as `refused`: nothing happened. */
export class Refused extends Error {
  readonly code: string;
  readonly text?: string;
  readonly data?: JSONValue;
  constructor(code: string, text?: string, data?: JSONValue) {
    super(text ?? code);
    this.code = code;
    this.text = text;
    this.data = data;
  }
}

/** Ends the action as `failed`: tried and not achieved, with the effects that did happen. */
export class Failed extends Error {
  readonly code: string;
  readonly text?: string;
  readonly effects: Effect[];
  readonly data?: JSONValue;
  constructor(code: string, text?: string, effects: Effect[] = [], data?: JSONValue) {
    super(text ?? code);
    this.code = code;
    this.text = text;
    this.effects = effects;
    this.data = data;
  }
}

/**
 * Says the action stopped when asked to (cancel, deadline or closing), with the effects from
 * before it stopped. The skeleton turns it into `cancelled` or `failed` with `deadline`.
 */
export class Stopped extends Error {
  readonly effects: Effect[];
  constructor(effects: Effect[] = []) {
    super("stopped");
    this.effects = effects;
  }
}

/** Ends the action as `unknown`: what is known and what is not confirmed. */
export class Uncertain extends Error {
  readonly code: string;
  readonly text: string;
  readonly known: { [key: string]: JSONValue };
  readonly unconfirmed: string[];
  readonly effects: Effect[];
  constructor(code: string, text: string, known: { [key: string]: JSONValue } = {}, unconfirmed: string[] = [], effects: Effect[] = []) {
    super(text);
    this.code = code;
    this.text = text;
    this.known = known;
    this.unconfirmed = unconfirmed;
    this.effects = effects;
  }
}

/** Shorthand for `throw new Refused(...)`. */
export function refuse(code: string, text?: string, data?: JSONValue): never {
  throw new Refused(code, text, data);
}

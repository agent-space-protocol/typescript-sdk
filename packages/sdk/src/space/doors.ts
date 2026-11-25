/**
 * The giving side of a handover through a door: lock the thing, offer it to the other space, and
 * remove it once the other side's record shows the take. After a disconnect midway, ask the other
 * side with `take`: its record decides.
 */
import type { OfferedThing, OfferResult, Outcome } from "../types/index.ts";
import { Participant } from "../participant/participant.ts";
import { randomToken, sleep } from "../util.ts";
import type { Space } from "./space.ts";

/** How to hand a thing over. */
export interface HandOverOptions {
  /** The door, a thing of this space declared in the capability `doors`. */
  door: string;
  /** The thing, with its parent types. */
  thing: OfferedThing;
  /** Locks the thing here, so nothing changes it during the handover. */
  lock(): void;
  /** Unlocks it when the other side did not take it: it stays here. */
  unlock(): void;
  /** Removes it once the other side took it. */
  remove(taken: OfferResult): void;
  /** The role to join as over there. */
  role?: string;
  /** How long to keep trying to learn the result after a disconnect, in milliseconds. */
  retryFor?: number;
  /** The offer ID; generated when absent. */
  offerId?: string;
}

/** The result of a handover. */
export type HandOverResult = { taken: true; result: OfferResult } | { taken: false; outcome?: Outcome };

/** Hands a thing over through a door. At every moment exactly one space owns it. */
export async function handOver(space: Space, options: HandOverOptions): Promise<HandOverResult> {
  const door = space.capabilities.doors?.doors?.find((d) => d.thing === options.door);
  if (!door) throw new Error(`no door ${options.door}`);
  const offerId = options.offerId ?? `offer-${randomToken(8)}`;
  options.lock();
  let offered = false;
  const until = Date.now() + (options.retryFor ?? 60000);
  for (;;) {
    let p: Participant | undefined;
    try {
      p = await Participant.connect(door.to, { key: space.key, reconnect: false });
      await p.join(options.role ? { role: options.role } : {});
      if (!offered) {
        offered = true;
        const res = await p.request<Outcome>({ type: "offer", id: offerId, door: options.door, thing: options.thing }).done;
        if (res.end === "done") {
          options.remove(res.result as unknown as OfferResult);
          return { taken: true, result: res.result as unknown as OfferResult };
        }
        if (res.end === "refused") {
          options.unlock();
          return { taken: false, outcome: res };
        }
        // unknown: the connection dropped; ask the other side's record.
      } else {
        const res = await p.request<Outcome>({ type: "take", offer: offerId }).done;
        if (res.end === "done") {
          const r = res.result as { taken: boolean; take?: number; thing?: string };
          if (r.taken) {
            const result = { thing: r.thing!, as: options.thing.type, take: r.take! };
            options.remove(result);
            return { taken: true, result };
          }
          options.unlock();
          return { taken: false };
        }
      }
    } catch {
      offered = true;
    } finally {
      p?.close();
    }
    if (Date.now() > until) throw new Error(`could not learn whether ${options.door} took ${options.thing.id}; it stays locked`);
    await sleep(200);
  }
}

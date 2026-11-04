import { DurableObject } from "cloudflare:workers";
import { handleApi, emptyState } from "./board.js";

// Requests to /api/* go to a single Durable Object ("the board"). Cloudflare runs
// one request at a time against it, so two people can never grab the last seat.
// Everything else (the page, styles, script) is served from ./public.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const board = env.BOARD.get(env.BOARD.idFromName("main"));
      return board.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class Board extends DurableObject {
  async fetch(request) {
    const state = (await this.ctx.storage.get("state")) || emptyState();
    const { response, changed } = await handleApi(request, state, this.env);
    if (changed) await this.ctx.storage.put("state", state);
    return response;
  }
}

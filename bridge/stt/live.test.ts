import { describe, expect, test } from "bun:test";

import { agree, createLiveStt, type LiveFetch } from "./live.ts";

describe("agree", () => {
  test("commits the words two passes share, case and punctuation aside", () => {
    expect(agree(["Okay,", "so", "for"], ["okay", "so", "for", "the", "Markov"])).toEqual({
      committed: "okay so for",
      pending: "the Markov",
    });
    expect(agree([], ["Okay", "so"])).toEqual({ committed: "", pending: "Okay so" });
  });
});

describe("createLiveStt", () => {
  test("re-sends the whole take each step, and the end answers the final pass", async () => {
    const sent: number[] = [];
    const replies = ["Okay so", "Okay so for the", "Okay so for the Markov blanket."];
    const fetchImpl: LiveFetch = (_url, init) => {
      sent.push(init.body.length);
      return Promise.resolve(new Response(JSON.stringify({ text: replies[sent.length - 1] })));
    };
    const live = createLiveStt({ baseUrl: "http://engine", fetchImpl });
    const half = new Uint8Array(16_000);
    expect(await live.step("take-0001", half, false)).toEqual({ committed: "", pending: "Okay so" });
    expect(await live.step("take-0001", half, false)).toEqual({ committed: "Okay so", pending: "for the" });
    expect(await live.step("take-0001", new Uint8Array(0), true)).toEqual({ text: "Okay so for the Markov blanket." });
    expect(sent).toEqual([16_000, 32_000, 32_000]);
  });
});

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDeviceSpeech } from "./use-device-speech";

class FakeUtterance extends EventTarget {
  readonly text: string;
  lang = "";
  constructor(text: string) {
    super();
    this.text = text;
  }
}

const originalSynthesis = window.speechSynthesis;
const originalUtterance = window.SpeechSynthesisUtterance;

afterEach(() => {
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: originalSynthesis });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    value: originalUtterance,
  });
});

describe("useDeviceSpeech", () => {
  it("queues chunks in the chosen language and stops after the final one", () => {
    const utterances: FakeUtterance[] = [];
    const synthesis = { cancel: vi.fn(), speak: vi.fn((u: FakeUtterance) => utterances.push(u)) };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synthesis });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: FakeUtterance,
    });

    const { result, unmount } = renderHook(() => useDeviceSpeech("en"));
    act(() => result.current.speak(["First.", "Second."]));
    expect(result.current.speaking).toBe(true);
    expect(utterances.map((u) => [u.text, u.lang])).toEqual([["First.", "en"]]);

    act(() => utterances[0]!.dispatchEvent(new Event("end")));
    expect(utterances.map((u) => u.text)).toEqual(["First.", "Second."]);
    act(() => utterances[1]!.dispatchEvent(new Event("end")));
    expect(result.current.speaking).toBe(false);
    unmount();
  });

  it("cancels without allowing a late event to advance the old queue", () => {
    const utterances: FakeUtterance[] = [];
    const synthesis = { cancel: vi.fn(), speak: vi.fn((u: FakeUtterance) => utterances.push(u)) };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synthesis });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: FakeUtterance,
    });

    const { result, unmount } = renderHook(() => useDeviceSpeech("en"));
    act(() => result.current.speak(["First.", "Must not play."]));
    act(() => result.current.stop());
    act(() => utterances[0]!.dispatchEvent(new Event("end")));
    expect(result.current.speaking).toBe(false);
    expect(utterances.map((u) => u.text)).toEqual(["First."]);
    unmount();
  });
});

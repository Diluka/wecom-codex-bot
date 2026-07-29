import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "@std/testing/bdd";

import { JsonlLineDecoder, readJsonLines } from "./jsonl.ts";

describe("JSONL decoding", () => {
  it("handles arbitrary UTF-8 chunks, CRLF, and a tail line", () => {
    const bytes = new TextEncoder().encode(
      '{"text":"ni hao"}\n{"text":"\u4f60\u597d"}\r\ntail',
    );
    const decoder = new JsonlLineDecoder();
    const lines: string[] = [];

    for (const byte of bytes) {
      lines.push(...decoder.push(Uint8Array.of(byte)));
    }
    lines.push(...decoder.finish());

    deepStrictEqual(lines, [
      '{"text":"ni hao"}',
      '{"text":"\u4f60\u597d"}',
      "tail",
    ]);
  });

  it("does not invent a tail after a final newline", () => {
    const decoder = new JsonlLineDecoder();

    deepStrictEqual(
      [
        ...decoder.push(new TextEncoder().encode("one\ntwo\n")),
        ...decoder.finish(),
      ],
      ["one", "two"],
    );
  });

  it("yields complete lines and the unterminated final line", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first\nsec"));
        controller.enqueue(encoder.encode("ond\nthird"));
        controller.close();
      },
    });
    const lines: string[] = [];

    for await (const line of readJsonLines(stream)) {
      lines.push(line);
    }

    deepStrictEqual(lines, ["first", "second", "third"]);
  });
});

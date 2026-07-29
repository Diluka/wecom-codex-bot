export class JsonlLineDecoder {
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #finished = false;

  push(chunk: Uint8Array): string[] {
    if (this.#finished) throw new Error("JSONL decoder is already finished");
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#takeCompleteLines();
  }

  finish(): string[] {
    if (this.#finished) return [];
    this.#finished = true;
    this.#buffer += this.#decoder.decode();

    const lines = this.#takeCompleteLines();
    if (this.#buffer.length > 0) {
      lines.push(this.#stripCarriageReturn(this.#buffer));
      this.#buffer = "";
    }
    return lines;
  }

  #takeCompleteLines(): string[] {
    const lines: string[] = [];
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return lines;
      lines.push(this.#stripCarriageReturn(this.#buffer.slice(0, newline)));
      this.#buffer = this.#buffer.slice(newline + 1);
    }
  }

  #stripCarriageReturn(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }
}

export async function* readJsonLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new JsonlLineDecoder();
  const reader = stream.getReader();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of decoder.push(value)) yield line;
    }
    for (const line of decoder.finish()) yield line;
  } finally {
    reader.releaseLock();
  }
}

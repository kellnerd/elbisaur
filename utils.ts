import type { InsertedListen, Listen } from "@kellnerd/listenbrainz/listen";
import { parseJson, parseJsonLines } from "@kellnerd/listenbrainz/parser/json";
import { assert } from "@std/assert/assert";
import { extname } from "@std/path/extname";

/** Splits the given asynchronous iterable into chunks of the given size. */
export async function* chunk<T>(
  input: AsyncIterable<T>,
  size: number,
): AsyncGenerator<T[]> {
  assert(
    Number.isInteger(size) && size >= 1,
    `Expected size to be an integer greater than 0 but found ${size}`,
  );

  let buffer = [];
  for await (const element of input) {
    if (buffer.push(element) === size) {
      yield buffer;
      buffer = [];
    }
  }

  if (buffer.length) {
    yield buffer;
  }
}

/** Logger which writes JSON messages into a JSONL file. */
export class JsonLogger {
  #encoder: TextEncoder;
  #output: WritableStreamDefaultWriter<Uint8Array> | undefined;

  /** Logger does nothing until {@linkcode JsonLogger.open} has been called. */
  constructor() {
    this.#encoder = new TextEncoder();
  }

  /** Opens the output file at the given path (in append mode). */
  async open(path: string | URL) {
    const outputFile = await Deno.open(path, {
      create: true,
      append: true,
    });
    this.#output = outputFile.writable.getWriter();
    await this.#output.ready;
  }

  /** Writes a line of stringified JSON into the output file. */
  async log(json: unknown) {
    if (!this.#output) return;
    const line = JSON.stringify(json) + "\n";
    await this.#output.write(this.#encoder.encode(line));
  }

  /** Closes the output file. */
  async close() {
    await this.#output?.close();
  }
}

/** Reads listens from a JSON or JSONL file at the given path. */
export async function* readListensFile(
  path: string,
): AsyncGenerator<Listen | InsertedListen> {
  const extension = extname(path);
  if (extension === ".jsonl") {
    const inputFile = await Deno.open(path);
    const input = inputFile.readable.pipeThrough(new TextDecoderStream());

    for await (const listen of parseJsonLines(input)) {
      yield listen;
    }
  } else if (extension === ".json") {
    const input = await Deno.readTextFile(path);

    for (const listen of parseJson(input)) {
      yield listen;
    }
  } else {
    throw new Error(`Unsupported file extension "${extension}"`);
  }
}

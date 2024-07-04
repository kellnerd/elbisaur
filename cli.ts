import { JsonLogger, readListensFile } from "./utils.ts";
import { Command, ValidationError } from "@cliffy/command";
import { ListenBrainzClient } from "@kellnerd/listenbrainz";
import {
  type AdditionalTrackInfo,
  cleanListen,
  formatListen,
  type Listen,
  setSubmissionClient,
  type Track,
} from "@kellnerd/listenbrainz/listen";
import { timestamp } from "@kellnerd/listenbrainz/timestamp";
import { parseMusicBrainzRelease } from "@kellnerd/listenbrainz/parser/musicbrainz";
import { parseScrobblerLog } from "@kellnerd/listenbrainz/parser/scrobbler-log";
import { parseSpotifyExtendedHistory } from "@kellnerd/listenbrainz/parser/spotify";
import { MusicBrainzClient } from "@kellnerd/musicbrainz";
import { parseTrackRange } from "@kellnerd/musicbrainz/utils/track";
import { brightBlue as opt, brightMagenta as cmd } from "@std/fmt/colors";
import { extname } from "@std/path/extname";
import { parse as parseYaml } from "@std/yaml";

/** MusicBrainz URLs which are accepted by the CLI. */
const musicBrainzUrlPattern = new URLPattern({
  pathname: "/release/:mbid([0-9a-f-]{36})",
});

const contactUrl = "https://github.com/kellnerd/listenbrainz-ts";

/** Cliffy command line interface of `elbisaur`. */
export const cli = new Command()
  .name("elbisaur")
  .version("0.8.2")
  .description("Manage your ListenBrainz listens and process listen dumps.")
  .globalEnv("LB_TOKEN=<UUID>", "ListenBrainz user token.", {
    prefix: "LB_",
    required: true,
  })
  .globalEnv(
    "ELBISAUR_LISTEN_TEMPLATE=<template>",
    "Template string to format a logged listen.",
    { prefix: "ELBISAUR_" },
  )
  .globalOption(
    "-a, --after <datetime>",
    "Only process tracks that were listened to after the given date/time.",
  )
  .globalOption(
    "-b, --before <datetime>",
    "Only process tracks that were listened to before the given date/time.",
  )
  .globalOption(
    "-f, --filter <conditions>",
    "Filter listens by track metadata (and additional info).",
  )
  .globalOption(
    "-x, --exclude-list <path:file>",
    "YAML file which maps track metadata keys to lists of forbidden values.",
  )
  .globalOption(
    "-i, --include-list <path:file>",
    "YAML file which maps track metadata keys to lists of allowed values.",
  )
  .action(function () {
    this.showHelp();
  })
  // Listening history
  .command("history", "Show the listening history of yourself or another user.")
  .env("LB_USER=<name>", "ListenBrainz username.", { prefix: "LB_" })
  .option("-u, --user <name>", "ListenBrainz username, defaults to yours.")
  .option("-c, --count <number:integer>", "Desired number of results (API).")
  .option(
    "-o, --output <path:file>",
    "Write listens into to the given JSONL file (append to existing file).",
  )
  .action(async function (options) {
    const listenFilter = await getListenFilter(options.filter, options);
    const client = new ListenBrainzClient({ userToken: options.token });
    if (!options.user) {
      const username = await client.validateToken();
      if (!username) {
        throw new ValidationError("Specified token is invalid");
      } else {
        options.user = username;
      }
    }
    const output = new JsonLogger();
    if (options.output) {
      await output.open(options.output);
    }
    const { listens } = await client.getListens(options.user, {
      min_ts: options.after ? timestamp(options.after) : undefined,
      max_ts: options.before ? timestamp(options.before) : undefined,
      count: options.count,
    });
    for (const listen of listens) {
      if (listenFilter(listen)) {
        console.log(formatListen(listen, options.listenTemplate));
        await output.log(listen);
      }
    }
    await output.close();
  })
  // Delete listens
  .command("delete <path:file>", "Delete listens in a JSON file from history.")
  .option("-p, --preview", "Show listens instead of deleting them.")
  .action(async function (options, path) {
    const listenFilter = await getListenFilter(options.filter, options);
    const listenSource = readListensFile(path);
    const client = new ListenBrainzClient({ userToken: options.token });
    let count = 0;
    for await (const listen of listenSource) {
      if (listenFilter(listen) && "recording_msid" in listen) {
        if (options.preview) {
          console.log(formatListen(listen, options.listenTemplate));
        } else {
          await client.deleteListen(listen);
          count++;
        }
      }
    }
    console.info(count, "listens deleted");
  })
  // Import JSON
  .command("import <path:file>", "Import listens from the given JSON file.")
  .option("-p, --preview", "Show listens instead of submitting them.")
  .action(async function (options, path) {
    const listenFilter = await getListenFilter(options.filter, options);
    const listenSource = readListensFile(path);
    if (options.preview) {
      for await (const listen of listenSource) {
        if (listenFilter(listen)) {
          console.log(formatListen(listen, options.listenTemplate));
        }
      }
    } else {
      const client = new ListenBrainzClient({ userToken: options.token });
      let listenBuffer: Listen[] = [];
      let count = 0;
      for await (const listen of listenSource) {
        if (!listenFilter(listen)) continue;
        const newListen = cleanListen(listen);
        setSubmissionClient(newListen.track_metadata, {
          name: "elbisaur (JSON importer)",
          version: this.getVersion()!,
        });
        if (listenBuffer.push(newListen) >= 100) {
          await client.import(listenBuffer);
          count += listenBuffer.length;
          console.info(count, "listens imported");
          listenBuffer = [];
        }
      }
      if (listenBuffer.length) {
        await client.import(listenBuffer);
        count += listenBuffer.length;
        console.info(count, "listens imported");
      }
    }
  })
  // Submit listen
  .command("listen <url|metadata> [track-range]")
  .description(`
    Submit listens for selected tracks from a release (given by its URL).
      <url>         = "https://musicbrainz.org/release/<MBID>"
      [track-range] = <first>-<last> | <prefix> | <medium>:<first>-<last>
    Or submit a single listen using the given track metadata.
      <metadata>    = "<artist> - <track-title>"
  `)
  .noGlobals() // except for the two env variables which are redefined below
  .env("LB_TOKEN=<UUID>", "ListenBrainz user token.", {
    prefix: "LB_",
    required: true,
  })
  .env(
    "ELBISAUR_LISTEN_TEMPLATE=<template>",
    "Template string to format a logged listen.",
    { prefix: "ELBISAUR_" },
  )
  .option("--at <datetime>", "Date/Time when you started listening.")
  .option("--now", "Submit a playing now notification.", { conflicts: ["at"] })
  .option("--until <datetime>", "Date/Time when you stopped listening.", {
    conflicts: ["at", "now"],
  })
  .option("-e, --edit <expression>", "Edit track metadata.", { collect: true })
  .option("-p, --preview", "Show listens instead of submitting them.")
  .action(async function (options, input, trackRange) {
    // Use the current time as end time by default, unless a start time is specified.
    let endTime: number | undefined = timestamp(options.until);
    if (isNaN(endTime)) {
      throw new ValidationError(`Invalid date "${options.until}"`);
    }
    let startTime: number | undefined;
    if (options.at) {
      startTime = timestamp(options.at);
      if (isNaN(startTime)) {
        throw new ValidationError(`Invalid date "${options.at}"`);
      }
      endTime = undefined;
    }
    const editListen = getListenModifier(options.edit);
    const client = new ListenBrainzClient({ userToken: options.token });
    let url: URL | undefined;
    try {
      url = new URL(input);
    } catch {
      url = undefined;
    }
    if (url) {
      const mbid = musicBrainzUrlPattern.exec(url)?.pathname.groups.mbid;
      if (mbid) {
        const mb = new MusicBrainzClient({
          app: {
            name: "elbisaur",
            version: this.getVersion()!,
            contact: contactUrl,
          },
        });
        const release = await mb.lookup("release", mbid, {
          inc: ["recordings", "artist-credits"],
        });
        const listens = parseMusicBrainzRelease(release, {
          startTime,
          endTime,
          tracks: parseTrackRange(trackRange ?? ""),
        });
        for (const listen of listens) {
          editListen(listen);
          setSubmissionClient(listen.track_metadata, {
            name: "elbisaur (release submitter)",
            version: this.getVersion()!,
          });
          if (options.preview) {
            console.log(formatListen(listen, options.listenTemplate));
          }
        }
        if (!options.preview) {
          if (options.now) {
            if (listens.length === 1) {
              await client.playingNow(listens[0].track_metadata);
            } else {
              throw new ValidationError(
                "Playing now notification can only be submitted for one track.",
              );
            }
          } else {
            await client.import(listens);
            console.info(listens.length, "listens submitted");
          }
        }
      } else {
        throw new ValidationError(
          "Unsupported URL, only MusicBrainz release URLs are allowed.",
        );
      }
    } else {
      if (!startTime) {
        throw new ValidationError('Missing value for option "--at".');
      }
      const trackMatch = input.match(/(?<artist>.+?) -+ (?<title>.+)/);
      if (trackMatch?.groups) {
        const track: Track = {
          artist_name: trackMatch.groups.artist,
          track_name: trackMatch.groups.title,
        };
        const listen: Listen = {
          listened_at: startTime,
          track_metadata: track,
        };
        editListen(listen);
        setSubmissionClient(track, {
          name: "elbisaur (track submitter)",
          version: this.getVersion()!,
        });
        if (options.preview) {
          console.log(formatListen(listen), options.listenTemplate);
        } else {
          if (options.now) {
            await client.playingNow(track);
            console.info("Playing now notification submitted");
          } else {
            await client.listen(track, startTime);
            console.info("Listen submitted");
          }
        }
      } else {
        throw new ValidationError(`Invalid metadata format "${input}"`);
      }
    }
  })
  // File parser
  .command("parse <input:file> [output:file]")
  .description(`
    Parse listens from the given input file and write them into a JSONL file.
    If no output file is specified, it will have the same name as the input,
    but with a ".jsonl" extension.

    Skipped listens are not discarded by default, but this should usually be
    done using a filter option, see examples.

    Supported formats: .scrobbler.log, Spotify Extended Streaming History (*.json)
  `)
  .option("-d, --debug", "Include debugging info in listens (if available).")
  .option("-p, --preview", "Show listens instead of writing them.")
  .option(
    "-t, --time-offset <seconds:integer>",
    "Add a time offset (in seconds) to all timestamps.",
    { default: 0 },
  )
  .example(
    "Rockbox log",
    `
    Parse .scrobbler.log file and discard all skipped scrobbles.
    ${cmd(`elbisaur parse .scrobbler.log`)} ${opt("--filter skipped!=1")}`,
  )
  .example(
    "Spotify history",
    `
    Parse Spotify Extended Streaming History and discard all skipped streams.
    Only keep streams which were played for at least 30 seconds as 'skipped' is not always set.
    ${cmd("elbisaur parse Streaming_History_Audio_2024.json")} ${
      opt("--filter 'skipped!=1&&ms_played>=30e3'")
    }`,
  )
  .action(async function (options, inputPath, outputPath) {
    const extension = extname(inputPath);
    const listenFilter = await getListenFilter(options.filter, options);
    const output = new JsonLogger();
    if (!options.preview) {
      await output.open(outputPath ?? inputPath + ".jsonl");
    }
    if (extension === ".log") {
      const inputFile = await Deno.open(inputPath);
      const input = inputFile.readable.pipeThrough(new TextDecoderStream());
      for await (const listen of parseScrobblerLog(input)) {
        if (listenFilter(listen)) {
          listen.listened_at += options.timeOffset;
          setSubmissionClient(listen.track_metadata, {
            name: "elbisaur (.scrobbler.log parser)",
            version: this.getVersion()!,
          });
          if (options.preview) {
            console.log(formatListen(listen, options.listenTemplate));
          } else {
            await output.log(listen);
          }
        }
      }
    } else if (extension === ".json") {
      const input = await Deno.readTextFile(inputPath);
      const history = parseSpotifyExtendedHistory(input, {
        includeDebugInfo: options.debug,
      });
      for (const listen of history) {
        if (listenFilter(listen)) {
          listen.listened_at += options.timeOffset;
          setSubmissionClient(listen.track_metadata, {
            name: "elbisaur (Spotify Extended Streaming History parser)",
            version: this.getVersion()!,
          });
          if (options.preview) {
            console.log(formatListen(listen, options.listenTemplate));
          } else {
            await output.log(listen);
          }
        }
      }
    } else {
      throw new ValidationError(`Unsupported file format "${extension}"`);
    }
    await output.close();
  })
  // Listen statistics
  .command("statistics <path:file>", "Show statistics for the given JSON file.")
  .option(
    "-k, --keys <keys:string[]>",
    "Track metadata keys to generate statistics for.",
    { default: ["artist_name", "release_name"] },
  )
  .action(async function (options, path) {
    const listenFilter = await getListenFilter(options.filter, options);
    const listenSource = readListensFile(path);
    const valueCounts: Record<string, Record<string, number>> = {};
    for (const key of options.keys) {
      valueCounts[key] = {};
    }
    for await (const listen of listenSource) {
      if (!listenFilter(listen)) continue;
      const track = listen.track_metadata;
      const info = track.additional_info;
      for (const key of options.keys) {
        const values = track[key as keyof Track] ??
          info?.[key as keyof AdditionalTrackInfo];
        const valueCountsForKey = valueCounts[key];
        for (const value of makeValidIndexTypes(values)) {
          if (valueCountsForKey[value]) {
            valueCountsForKey[value]++;
          } else {
            valueCountsForKey[value] = 1;
          }
        }
      }
    }
    // Print stats with values ordered by count in descending order.
    for (const key of options.keys) {
      console.log(`\n${key}:`);
      const stats = Object.entries(valueCounts[key])
        .sort(([_a, countA], [_b, countB]) => countB - countA);
      for (const [value, count] of stats) {
        console.log(count, "\t", value !== "" ? value : undefined);
      }
    }
  })
  // Modify listens
  .command(
    "transform <input:file> <output:file>",
    "Modify listens from a JSON input file and write them into a JSONL file.",
  )
  .option("-p, --preview", "Show listens instead of writing them.")
  .option("-e, --edit <expression>", "Edit track metadata.", { collect: true })
  .option(
    "-t, --time-offset <seconds:integer>",
    "Add a time offset (in seconds) to all timestamps.",
    { default: 0 },
  )
  .action(async function (options, inputPath, outputPath) {
    const listenFilter = await getListenFilter(options.filter, options);
    const editListen = getListenModifier(options.edit);
    const listenSource = readListensFile(inputPath);
    const output = new JsonLogger();
    if (!options.preview) {
      await output.open(outputPath);
    }
    for await (const listen of listenSource) {
      if (listenFilter(listen)) {
        editListen(listen);
        listen.listened_at += options.timeOffset;
        setSubmissionClient(listen.track_metadata, {
          name: "elbisaur (listen transformer)",
          version: this.getVersion()!,
          overwrite: true,
        });
        if (options.preview) {
          console.log(formatListen(listen, options.listenTemplate));
        } else {
          await output.log(listen);
        }
      }
    }
    await output.close();
  });

async function getListenFilter(filterSpecification?: string, options: {
  after?: string;
  before?: string;
  excludeList?: string;
  includeList?: string;
} = {}) {
  const conditions = filterSpecification?.split("&&").map((expression) => {
    const condition = expression.match(
      /^(?<key>\w+)(?<operator>==|!=|<=|<|>=|>|\^)(?<value>.*)/,
    )?.groups;
    if (!condition) {
      throw new ValidationError(`Invalid filter expression "${expression}"`);
    }
    return condition as {
      key: string;
      operator: "==" | "!=" | "<=" | "<" | ">=" | ">" | "^";
      value: string | string[];
    };
  }) ?? [];

  const minTs = options.after ? timestamp(options.after) : 0;
  if (isNaN(minTs)) {
    throw new ValidationError(`Invalid date "${options.after}"`);
  }

  const maxTs = options.before ? timestamp(options.before) : Infinity;
  if (isNaN(maxTs)) {
    throw new ValidationError(`Invalid date "${options.before}"`);
  }

  if (options.excludeList) {
    await loadConditionsFromYaml(options.excludeList, "!=");
  }

  if (options.includeList) {
    await loadConditionsFromYaml(options.includeList, "==");
  }

  async function loadConditionsFromYaml(path: string, operator: "==" | "!=") {
    const content = await Deno.readTextFile(path);
    const excludeMap = parseYaml(content) as Record<string, unknown>;
    for (const [key, values] of Object.entries(excludeMap)) {
      if (Array.isArray(values)) {
        conditions.push({ key, operator, value: values });
      } else {
        throw new ValidationError(`"${key}" from "${path}" has to be a list`);
      }
    }
  }

  return function (listen: Listen) {
    if (listen.listened_at <= minTs || listen.listened_at >= maxTs) {
      return false;
    }
    const track = listen.track_metadata;
    const info = track.additional_info ?? {};

    return conditions.every(({ key, operator, value }) => {
      const actualValue = track[key as keyof Track] ??
        info[key as keyof AdditionalTrackInfo];

      if (Array.isArray(actualValue)) {
        console.warn(`Ignoring condition for "${key}" (has multiple values)`);
        return true;
      } else if (Array.isArray(value)) {
        if (operator === "==") {
          return value.some((value) => compare(actualValue, value) === 0);
        } else if (operator === "!=") {
          return value.every((value) => compare(actualValue, value) !== 0);
        } else {
          console.warn(
            `Ignoring condition for "${key}" ("${operator}" does not accept multiple values)`,
          );
          return true;
        }
      }

      switch (operator) {
        case "==":
          return compare(actualValue, value) === 0;
        case "!=":
          return compare(actualValue, value) !== 0;
        case "^": // XOR
          return actualValue && !value || !actualValue && value;
        case "<=":
          return compare(actualValue, value) <= 0;
        case "<":
          return compare(actualValue, value) < 0;
        case ">=":
          return compare(actualValue, value) >= 0;
        case ">":
          return compare(actualValue, value) > 0;
      }
    });
  };
}

function getListenModifier(expressions?: string[]) {
  const edits = expressions?.map((expression) => {
    const edit = expression.match(
      /^(?<key>\w+)(?<operator>=)(?<value>.*)/,
    )?.groups;
    if (!edit) {
      throw new ValidationError(`Invalid edit expression "${expression}"`);
    }
    return edit as { key: string; operator: "="; value: string };
  });

  return function (listen: Listen) {
    if (!edits) return;
    const track = listen.track_metadata;
    for (const { key, value } of edits) {
      if (
        key === "track_name" || key === "artist_name" || key === "release_name"
      ) {
        track[key] = value;
      } else {
        const info = track.additional_info ??= {};
        info[key] = value;
      }
    }
  };
}

function makeValidIndexTypes(input: unknown): Array<string | number> {
  if (typeof input === "string" || typeof input === "number") return [input];
  if (typeof input === "boolean" || input === null) return [String(input)];
  if (input === undefined) return [""];
  if (Array.isArray(input)) return input.flatMap(makeValidIndexTypes);
  return [];
}

/**
 * Compares two operands numerically (numbers) or lexicographically (strings).
 * The type of comparison depends on the type of the first operand.
 *
 * Boolean operands are treated as numbers `0` and `1`.
 * Values `null` and `undefined` are treated as empty strings.
 * All other operand types are rejected with an error.
 */
function compare(actualValue: unknown, value: string): number {
  if (typeof actualValue === "boolean") {
    actualValue = Number(actualValue);
  } else if (actualValue === undefined || actualValue === null) {
    actualValue = "";
  }

  if (typeof actualValue === "number") return actualValue - Number(value);
  if (typeof actualValue === "string") return actualValue.localeCompare(value);
  throw new ValidationError(`Comparison is not allowed for ${actualValue}`);
}

if (import.meta.main) {
  // Automatically load environment variables from `.env` file.
  await import("@std/dotenv/load");

  await cli.parse();
}

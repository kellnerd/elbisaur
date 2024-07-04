import { ValidationError } from "@cliffy/command";
import type {
  AdditionalTrackInfo,
  Listen,
  Track,
} from "@kellnerd/listenbrainz/listen";
import { timestamp } from "@kellnerd/listenbrainz/timestamp";
import { parse as parseYaml } from "@std/yaml";

export async function getListenFilter(filterSpecification?: string, options: {
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

/**
 * Compares two operands numerically (numbers) or lexicographically (strings).
 * The type of comparison depends on the type of the first operand.
 *
 * Boolean operands are treated as numbers `0` and `1`.
 * Values `null` and `undefined` are treated as empty strings.
 * All other operand types are rejected with an error.
 */
export function compare(actualValue: unknown, value: string): number {
  if (typeof actualValue === "boolean") {
    actualValue = Number(actualValue);
  } else if (actualValue === undefined || actualValue === null) {
    actualValue = "";
  }

  if (typeof actualValue === "number") return actualValue - Number(value);
  if (typeof actualValue === "string") return actualValue.localeCompare(value);
  throw new ValidationError(`Comparison is not allowed for ${actualValue}`);
}

import { ValidationError } from "@cliffy/command";
import type { Listen } from "@kellnerd/listenbrainz/listen";

export function getListenModifier(expressions?: string[]) {
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

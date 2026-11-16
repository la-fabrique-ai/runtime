// How long ago, for the displays of the team's status (the host's text output
// and `forge team watch`): enough to tell whether a question has waited long.
export function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export function mirrorLine(team: string, originAgeSeconds: number | null): string {
  return `${team}: origin mirror ${originAgeSeconds === null ? "never synced" : `synced ${ageLabel(originAgeSeconds * 1000)} ago`}`;
}

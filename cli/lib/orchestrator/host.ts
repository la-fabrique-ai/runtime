// Contrat de l'API hôte, vu de l'orchestrateur (qui tourne dans un container).
// L'hôte l'implémente (plan 1c) sur un socket ; le client est ajouté plus tard.
//
// Format sur le fil, une ligne JSON dans chaque sens :
//   {"op":"status"}                                  -> {"ok":true,"executors":[ExecutorStatus…]}
//   {"op":"assign","to":…,"mission":{MissionSpec}}   -> {"ok":true}
//   {"op":"release","to":…}                          -> {"ok":true}
//   {"op":"events","after":<n>}                      -> {"ok":true,"events":[HostEvent…]}
//   tout refus                                       -> {"ok":false,"error":"…"}

export type MissionKind = "dev";

export type MissionSpec = {
  kind: MissionKind;
  ticket: string;
  subtask: string;
  repository: string;
  branch: string;
  base: string;
  instruction: string;
};

export type HeldMission = Omit<MissionSpec, "instruction">;

export type SessionState = "none" | "idle" | "working" | "done" | "exited" | "lost" | "unknown";

export type ExecutorStatus = { name: string; mission: HeldMission | null; session: SessionState };

export type HostEvent = { id: number; kind: "done"; executor: string; ticket: string; subtask: string; branch: string };

export interface HostApi {
  status(): Promise<ExecutorStatus[]>;
  assign(to: string, mission: MissionSpec): Promise<void>;
  release(to: string): Promise<void>;
  events(after: number): Promise<HostEvent[]>;
}

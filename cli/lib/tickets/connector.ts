import type {
  Comment,
  CommentKind,
  Mission,
  MissionFile,
  Problem,
  Repo,
  Request,
  Subtask,
  SubtaskKind,
  SubtaskStatus,
  Ticket,
  TicketStatus,
} from "./model.ts";

// Le connecteur : tout ce que la forge lit ou écrit dans un gestionnaire de
// tickets. Chaque méthode prend un objet et renvoie une promesse.
export interface Connector {
  // Triés par priorité (1 à 4, puis 0), puis par numéro d'identifiant.
  listTickets(a: { status?: TicketStatus[] }): Promise<{ tickets: Ticket[]; problems: Problem[] }>;
  getTicket(a: { id: string }): Promise<Ticket>;
  // Triées par `rank`.
  listSubtasks(a: { ticket: string }): Promise<Subtask[]>;
  // `open: true` : seulement les demandes sans réponse.
  listRequests(a: { ticket: string; open?: boolean }): Promise<Request[]>;
  // Les commentaires d'id supérieur à `after`, du plus ancien au plus récent.
  listComments(a: { ticket: string; after?: string }): Promise<{ comments: Comment[]; cursor: string | null }>;
  readMission(a: { ticket: string }): Promise<Mission>;

  createTicket(a: {
    title: string;
    description: string;
    priority?: 0 | 1 | 2 | 3 | 4;
    repositories: Repo[];
  }): Promise<Ticket>;
  setTicketStatus(a: { id: string; status: TicketStatus }): Promise<Ticket>;
  createSubtask(a: {
    ticket: string;
    repository: string;
    position: number;
    rank: number;
    kind: SubtaskKind;
    fixes?: string;
    text: string;
  }): Promise<Subtask>;
  setSubtaskStatus(a: { id: string; status: SubtaskStatus; reason?: "rebase" }): Promise<Subtask>;
  setSubtaskLinks(a: { id: string; branch?: string; pr?: string }): Promise<Subtask>;
  openRequest(a: { ticket: string; subtask: string; text: string; recommended?: string }): Promise<Request>;
  answerRequest(a: { ticket: string; id: string; text: string }): Promise<Request>;
  addComment(a: { ticket: string; author: string; kind: CommentKind; text: string }): Promise<Comment>;
  writeMission(a: { ticket: string; file: MissionFile; text: string }): Promise<Mission>;
}

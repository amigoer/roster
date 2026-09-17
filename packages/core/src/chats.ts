import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ID = /^[0-9a-f-]{36}$/;

/**
 * A worktree of Roster's own for a conversation that is not about a
 * repository, one folder per conversation under the data directory. What a
 * bot writes there stays with the conversation: it goes when the conversation
 * is deleted and stays when it is archived. Attachments are not here: those
 * live under the attachment store whatever the working directory is.
 */
export class ChatSpaces {
  constructor(readonly root: string) {}

  path(conversationId: string): string {
    if (!ID.test(conversationId)) throw new Error(`not a conversation id: ${conversationId}`);
    return join(this.root, conversationId);
  }

  /** Makes the folder, or leaves an existing one as it is. */
  create(conversationId: string): string {
    const dir = this.path(conversationId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  remove(conversationId: string): void {
    if (ID.test(conversationId)) rmSync(join(this.root, conversationId), { recursive: true, force: true });
  }
}

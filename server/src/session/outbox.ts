/** Reading the app's answers in a copied mailbox. */
import fs from "node:fs";
import path from "node:path";
import { parseOutboxItem, type OutboxItem } from "../format.ts";

/** The outbox item that answers `commandId`, if the copy has it. */
export function findOutboxItem(mailboxRoot: string, commandId: string): OutboxItem | undefined {
  const outbox = path.join(mailboxRoot, "outbox");
  if (!fs.existsSync(outbox)) return undefined;
  for (const file of fs.readdirSync(outbox).sort()) {
    if (file.startsWith(".")) continue;
    try {
      const item = parseOutboxItem(fs.readFileSync(path.join(outbox, file), "utf8"));
      if (item.commandId === commandId) return item;
    } catch {
      // Not an outbox item this server can read; skip it.
    }
  }
  return undefined;
}

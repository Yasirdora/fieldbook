/**
 * Mac tools: posting a Darwin notification and capturing one window.
 * Command shapes: `notifyutil -p <name>` and `screencapture -l <windowid> <file>`.
 */

export const macTools = {
  notify: (name: string): string[] => ["notifyutil", "-p", name],
  screencapture: (windowNumber: number, file: string): string[] => ["screencapture", "-l", String(windowNumber), file],
};

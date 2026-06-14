/**
 * App-wide toast bus. Deliberately framework-free (a module singleton, not a
 * React context) so it can be fired from anywhere — including the plain `api()`
 * fetch helper, which isn't a component and can't use hooks. The <ToastHost/>
 * mounted at the app root subscribes and renders the stack.
 */
export type ToastKind = "error" | "success" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function emit(): void {
  for (const l of listeners) l(toasts);
}

/** Subscribe to the toast list; immediately receives the current list. */
export function subscribeToasts(l: Listener): () => void {
  listeners.add(l);
  l(toasts);
  return () => {
    listeners.delete(l);
  };
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function push(kind: ToastKind, message: string, ttlMs: number): number {
  const id = nextId++;
  // Collapse an identical message already on screen (e.g. a double-click) so the
  // same error doesn't stack three deep.
  if (toasts.some((t) => t.kind === kind && t.message === message)) return id;
  toasts = [...toasts, { id, kind, message }];
  emit();
  if (ttlMs > 0) setTimeout(() => dismissToast(id), ttlMs);
  return id;
}

export const toast = {
  error: (message: string): number => push("error", message, 6000),
  success: (message: string): number => push("success", message, 3500),
  info: (message: string): number => push("info", message, 4500),
};

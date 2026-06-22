/**
 * Run a single worker job in isolation. A throw is logged with the job name and
 * swallowed, so one failing job never starves the others in the same tick.
 * Returns the job's result on success, or undefined on failure.
 */
export async function runJob<T>(
  logger: { error: (obj: object, msg?: string) => void },
  name: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, job: name }, "worker job failed");
    return undefined;
  }
}

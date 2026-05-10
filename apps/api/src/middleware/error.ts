import type { Context, ErrorHandler } from "hono";
import { ZodError } from "zod";
import type { StatusCode } from "hono/utils/http-status";
import { AppError } from "../lib/errors.js";
import { logger } from "../logger.js";

export const onError: ErrorHandler = (err, c: Context) => {
  const requestId = c.get("requestId") as string | undefined;
  if (err instanceof AppError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { ...err.details, request_id: requestId },
        },
      },
      err.status as StatusCode,
    );
  }
  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: "validation_failed",
          message: "invalid request",
          details: { issues: err.issues, request_id: requestId },
        },
      },
      400,
    );
  }
  logger.error({ err, requestId }, "unhandled error");
  return c.json(
    {
      error: {
        code: "internal_error",
        message: "an unexpected error occurred",
        details: { request_id: requestId },
      },
    },
    500,
  );
};

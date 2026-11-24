import { z } from "zod";
import { badRequest } from "./errors.js";

/** Parse with a zod schema or throw a 400 with per-field messages. */
export function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const fields = {};
    for (const issue of r.error.issues) {
      const k = issue.path.join(".") || "_";
      if (!fields[k]) fields[k] = issue.message;
    }
    const first = Object.entries(fields)[0];
    throw badRequest(first ? `${first[0] === "_" ? "" : first[0] + ": "}${first[1]}` : "Invalid input.", "validation_error", { fields });
  }
  return r.data;
}

export const zEmail = z.string().trim().toLowerCase().email("Enter a valid email address.").max(254);
export const zPassword = z.string().min(8, "Password must be at least 8 characters.").max(200);
export const zUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return ["http:", "https:"].includes(u.protocol) && u.hostname.includes(".");
    } catch {
      return false;
    }
  }, "Enter a valid website address, e.g. https://example.com");
export const zHex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "Use a hex color like #1F3A5F");
export const zId = z.coerce.number().int().positive();
export { z };

import { z } from "zod";
export type { OneFetchCapabilitiesV1 } from "@one-fetch/protocol";
import {
  HeaderEntryV1Schema,
  HeaderMutationNoticeV1Schema,
  OneFetchTimingV1Schema,
  OneFetchProblemV1Schema,
  UserDenyRulesV1Schema,
} from "@one-fetch/protocol";

/** Service URLs may contain a Supabase function prefix, never credentials. */
export const oneFetchServiceUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      !url.username &&
      !url.password &&
      !value.includes("?") &&
      !value.includes("#")
    );
  }, "Expected HTTPS (or loopback HTTP) without credentials, query or fragment");

export const oneFetchProfileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(128),
    name: z.string().trim().min(1).max(128),
    controlUrl: oneFetchServiceUrlSchema,
    gatewayUrl: oneFetchServiceUrlSchema,
    tokenStorage: z.enum(["session", "local"]),
    allowLoopbackHttp: z.boolean().default(false),
    userDenyRules: UserDenyRulesV1Schema.default({
      schemaVersion: 1,
      rules: [],
    }),
  })
  .strict()
  .superRefine((profile, context) => {
    if (
      profile.controlUrl.replace(/\/+$/u, "") ===
      profile.gatewayUrl.replace(/\/+$/u, "")
    ) {
      context.addIssue({
        code: "custom",
        path: ["gatewayUrl"],
        message: "Control and Gateway need separate service URLs",
      });
    }
    if (
      !profile.allowLoopbackHttp &&
      [profile.controlUrl, profile.gatewayUrl].some(
        (url) => new URL(url).protocol === "http:",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowLoopbackHttp"],
        message: "Confirm the loopback HTTP risk before saving",
      });
    }
  });
export type OneFetchProfileV1 = z.infer<typeof oneFetchProfileV1Schema>;

/** Consent binds the exact service capability snapshot, never a persisted token. */
export const oneFetchConsentV1Schema = z
  .object({
    instanceId: z.string().min(1).max(128),
    pairId: z.string().min(1).max(128),
    configVersion: z.string().min(1).max(256),
    buildVersion: z.string().min(1).max(128),
  })
  .strict();
export type OneFetchConsentV1 = z.infer<typeof oneFetchConsentV1Schema>;

/** Local sidecar: not part of portable RequestSpec/ResponseRecord/collections. */
export const oneFetchResponseDetailsV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.enum(["target", "relay-error", "intermediary"]),
    reason: z.string().max(256).optional(),
    outerStatus: z.number().int().min(100).max(599),
    outerHeaders: z.array(HeaderEntryV1Schema).max(256),
    configVersion: z.string().max(256).optional(),
    timing: OneFetchTimingV1Schema.optional(),
    mutations: z.array(HeaderMutationNoticeV1Schema).max(256),
    audit: z.enum(["recorded", "degraded", "unknown"]),
    integrity: z.enum(["pending", "verified", "unverified", "failed"]),
    reportId: z.string().max(128).optional(),
    bodySha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    problem: OneFetchProblemV1Schema.optional(),
  })
  .strict();
export type OneFetchResponseDetailsV1 = z.infer<
  typeof oneFetchResponseDetailsV1Schema
>;

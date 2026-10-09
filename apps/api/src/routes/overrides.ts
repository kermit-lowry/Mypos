import { appliesTo, canUsePin, PermissionKeys, PermissionLevels, PERMISSIONS, type EffectivePermissions, type Permission, type PermissionLevel, type StaffKind } from "@mypos/shared";
import { z } from "zod";

/** Permission overrides as the staff and users routes take them, and what the grant guards compare with. */

const Level = z.enum(PermissionLevels);

/**
 * A level map as clients send it back. Keys of permissions that no longer exist
 * (the retired BACK_OFFICE_LOGIN, still in maps saved before it was removed) are
 * dropped, the same way effectivePermissions ignores them on read; any other
 * unknown key is still a mistake.
 */
const RETIRED = new Set(["BACK_OFFICE_LOGIN"]);
const LevelMap = z
  .record(z.string(), Level)
  .transform((o) => Object.fromEntries(Object.entries(o).filter(([k]) => !RETIRED.has(k))))
  .pipe(z.record(z.enum(PermissionKeys as [Permission, ...Permission[]]), Level));

/** Page and sign-in permissions have no PIN prompt, so PIN isn't a level they can take. */
const noPinOnPages = (o: Partial<Record<Permission, PermissionLevel>>, ctx: z.RefinementCtx) => {
  for (const [p, level] of Object.entries(o)) {
    if (level === "PIN" && !canUsePin(p as Permission)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [p], message: `${p} ("${PERMISSIONS[p as Permission].label}") is allowed or not allowed; there's no PIN prompt for it` });
    }
  }
};

/** Any permission (role policies apply to employees and website users alike). */
export const Overrides = LevelMap.superRefine(noPinOnPages);

/** Overrides for one kind of account: only the permissions that apply to it, and no PIN level for a website user (there's no PIN pad on the website). */
export const overridesFor = (kind: StaffKind) =>
  LevelMap.superRefine((o, ctx) => {
    noPinOnPages(o, ctx);
    for (const [p, level] of Object.entries(o)) {
      if (!appliesTo(p as Permission, kind)) {
        const where = kind === "USER" ? "the website" : "the register";
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [p], message: `${p} ("${PERMISSIONS[p as Permission].label}") doesn't apply on ${where}` });
      } else if (level === "PIN" && kind === "USER") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [p], message: `${p} ("${PERMISSIONS[p as Permission].label}") is allowed or not allowed for a website user; there's no PIN pad on the website` });
      }
    }
  });

export type OverrideMap = Partial<Record<Permission, PermissionLevel>>;

export const RANK: Record<PermissionLevel, number> = { DENY: 0, PIN: 1, ALLOW: 2 };
/** What someone who doesn't exist yet can do. */
export const NOTHING: EffectivePermissions = { levels: Object.fromEntries(PermissionKeys.map((p) => [p, "DENY"])) as Record<Permission, PermissionLevel>, discountMaxBps: 0 };

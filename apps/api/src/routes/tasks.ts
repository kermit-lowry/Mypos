import { StaffRole, TaskAssignee, TaskPriority, TaskRecurrence, TaskStatus } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authorize, parse, requirePermission, requireStaff } from "../http.js";
import type { Ctx } from "../services/context.js";
import { permissionDenied } from "../services/permissions.js";
import * as T from "../services/tasks.js";
import { localDate } from "../services/timeclock.js";

/**
 * Employee tasks: managers define them (one-off or daily / weekly / monthly,
 * per store or every store, for anyone, a role or one employee); each day's
 * occurrence is what employees complete, with a checklist and an optional note.
 *
 * An occurrence (every occurrence endpoint, and the lists):
 *   { id, taskId, locationId, title, instructions, checklist: string[], checklistDone: number[],
 *     priority, recurrence, requireNote, dueOn: "YYYY-MM-DD", dueAt, dueTime, status: "OPEN"|"DONE"|"SKIPPED",
 *     assignee: { type, role?, employee?: { id, name } }, completedBy: { id, name }|null, completedAt, late, note, skipReason }
 */
export function taskRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireStaff() };
  const manage = { preHandler: requirePermission("MANAGE_TASKS") };
  const ip = (req: FastifyRequest) => req.ip;
  const Id = z.object({ id: z.string().min(1) });
  const Day = z.string().regex(T.DAY_RE, "YYYY-MM-DD").refine(T.isValidDay, "Not a real date");
  const Note = z.string().trim().max(1000);
  const Indices = z.array(z.number().int().min(0).max(29)).max(30);
  /** A "true"/"false" query flag (z.coerce.boolean would read "false" as true). */
  const Flag = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");
  const canManage = (req: FastifyRequest) => req.perms?.levels.MANAGE_TASKS === "ALLOW";
  const who = (req: FastifyRequest) => ({ staffId: req.user.sub, role: req.staffRole ?? req.user.role, manage: canManage(req) });
  async function timeZoneOf(locationId?: string) {
    const loc = locationId ? await prisma.location.findUnique({ where: { id: locationId } }) : await prisma.location.findFirst({ orderBy: { createdAt: "asc" } });
    return loc?.timezone ?? "America/New_York";
  }

  // ── Definitions (managers) ────────────────────────────────────

  const TaskBody = z.object({
    locationId: z.string().min(1).nullable().optional(),
    title: z.string().trim().min(1).max(120),
    instructions: z.string().trim().max(2000).nullable().optional(),
    checklist: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
    priority: z.nativeEnum(TaskPriority).optional(),
    recurrence: z.nativeEnum(TaskRecurrence),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    dueTime: z.string().regex(T.TIME_RE, "HH:mm").nullable().optional(),
    startsOn: Day,
    endsOn: Day.nullable().optional(),
    assigneeType: z.nativeEnum(TaskAssignee).optional(),
    assigneeRole: z.nativeEnum(StaffRole).nullable().optional(),
    assigneeId: z.string().min(1).nullable().optional(),
    requireNote: z.boolean().optional(),
    active: z.boolean().optional(),
  });

  /** Every task definition (`locationId` includes every-store tasks), with names and `nextDueOn`. */
  app.get("/tasks", manage, async (req) => {
    const q = parse(z.object({ locationId: z.string().optional(), active: Flag.optional(), recurrence: z.nativeEnum(TaskRecurrence).optional(), assigneeId: z.string().optional() }), req.query);
    return { tasks: await T.listTasks(prisma, q) };
  });

  app.post("/tasks", manage, async (req, reply) => {
    const body = parse(TaskBody, req.body);
    return reply.code(201).send({ task: await T.createTask(prisma, body, req.user.sub) });
  });

  /** Changing the schedule, place or assignee drops the task's open occurrences from today on and recreates them. */
  app.patch("/tasks/:id", manage, async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(TaskBody.partial(), req.body ?? {});
    return { task: await T.updateTask(prisma, id, body, req.user.sub) };
  });

  /** Deactivate (history is kept). */
  app.delete("/tasks/:id", manage, async (req) => {
    const { id } = parse(Id, req.params);
    return { task: await T.deactivateTask(prisma, id, req.user.sub) };
  });

  // ── The signed-in employee ────────────────────────────────────

  /**
   * What to show at sign-in: { today, overdue, upcoming, counts: { open, overdue, doneToday } }.
   * Visible = for anyone, for their role, or for them.
   */
  app.get("/tasks/mine", staff, async (req) => {
    const { locationId } = parse(z.object({ locationId: z.string().min(1) }), req.query);
    return T.mine(prisma, { staffId: req.user.sub, role: req.staffRole ?? req.user.role, locationId });
  });

  /** Tick checklist steps without completing. { done: number[] } */
  app.post("/tasks/occurrences/:id/checklist", staff, async (req) => {
    const { id } = parse(Id, req.params);
    const { done } = parse(z.object({ done: Indices }), req.body);
    return { occurrence: await T.saveChecklist(prisma, { occurrenceId: id, ...who(req), done }) };
  });

  /** 409 TASK_NOT_OPEN, 403 TASK_NOT_YOURS, 400 NOTE_REQUIRED. */
  app.post("/tasks/occurrences/:id/complete", staff, async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(z.object({ note: Note.nullable().optional(), checklistDone: Indices.optional() }), req.body ?? {});
    return { occurrence: await T.complete(prisma, { occurrenceId: id, ...who(req), note: body.note, checklistDone: body.checklistDone, ip: ip(req) }) };
  });

  /** Skip with a reason; a cashier needs a manager's PIN (TASK_SKIP). 403 TASK_NOT_YOURS unless it's theirs or they manage tasks. */
  app.post("/tasks/occurrences/:id/skip", staff, async (req) => {
    const { id } = parse(Id, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(300) }), req.body);
    await authorize(req, "TASK_SKIP", "skip task");
    return { occurrence: await T.skip(prisma, { occurrenceId: id, ...who(req), reason, approverId: req.approverId, ip: ip(req) }) };
  });

  app.post("/tasks/occurrences/:id/reopen", manage, async (req) => {
    const { id } = parse(Id, req.params);
    return { occurrence: await T.reopen(prisma, { occurrenceId: id, staffId: req.user.sub, ip: ip(req) }) };
  });

  // ── Managing the day and the history ──────────────────────────

  /** One day at a store: every occurrence plus what is still overdue. */
  app.get("/tasks/board", manage, async (req) => {
    const q = parse(z.object({ locationId: z.string().min(1), date: Day.optional() }), req.query);
    const date = q.date ?? localDate(new Date(), await timeZoneOf(q.locationId));
    return T.board(prisma, { locationId: q.locationId, date });
  });

  /** History, newest first (max 500). */
  app.get("/tasks/occurrences", manage, async (req) => {
    const q = parse(
      z.object({
        locationId: z.string().optional(),
        from: Day.optional(),
        to: Day.optional(),
        status: z.nativeEnum(TaskStatus).optional(),
        staffId: z.string().optional(),
        taskId: z.string().optional(),
        take: z.coerce.number().int().min(1).max(500).default(500),
      }),
      req.query,
    );
    return { occurrences: await T.listOccurrences(prisma, q) };
  });

  /** Completion per task and per employee. VIEW_REPORTS or MANAGE_TASKS. `format=csv` gives the per-task rows. */
  app.get("/tasks/report", staff, async (req, reply) => {
    if (!canManage(req) && req.perms?.levels.VIEW_REPORTS !== "ALLOW") throw permissionDenied("MANAGE_TASKS");
    const q = parse(z.object({ locationId: z.string().optional(), from: Day, to: Day, format: z.enum(["json", "csv"]).default("json") }), req.query);
    const r = await T.report(prisma, q);
    if (q.format !== "csv") return r;
    return reply.type("text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="tasks.csv"').send(T.reportCsv(r));
  });
}

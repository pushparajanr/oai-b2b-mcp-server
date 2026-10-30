import { z } from "zod";
import { Agent, uid, coll } from "./base.js";

const init = (s) => coll(s, "projects", "tasks", "issues", "approvals");

export const workfront = new Agent({
  key: "workfront", name: "Workfront Agent", product: "Adobe Workfront",
  description: "Projects, tasks, issues, assignments, approvals and campaign operations.",
  keywords: ["workfront", "project", "task", "issue", "assign", "approval", "approve", "proof", "campaign operations", "deadline"],
  tools: {
    create_project: { description: "Create a project (e.g. a campaign request).", shape: 1,
      schema: z.object({ name: z.string(), owner: z.string(), dueDate: z.string().optional(), campaignId: z.string().optional() }),
      run(a, s) { init(s); const v = { id: uid("prj"), ...a, status: "planning" }; s.projects.set(v.id, v); return v; } },
    create_task: { description: "Add a task to a project.", shape: 1,
      schema: z.object({ projectId: z.string(), name: z.string(), assignee: z.string().optional(), dueDate: z.string().optional(), dependsOn: z.array(z.string()).default([]) }),
      run(a, s) { init(s); if (!s.projects.has(a.projectId)) throw new Error(`Unknown project '${a.projectId}'`);
        for (const d of a.dependsOn) if (!s.tasks.has(d)) throw new Error(`Unknown dependency '${d}'`);
        const v = { id: uid("tsk"), ...a, status: "new" }; s.tasks.set(v.id, v); return v; } },
    update_task_status: { description: "Set task status; blocked while dependencies are incomplete.", shape: 1,
      schema: z.object({ taskId: z.string(), status: z.enum(["new", "in_progress", "complete"]) }),
      run(a, s) { init(s); const t = s.tasks.get(a.taskId); if (!t) throw new Error(`Unknown task '${a.taskId}'`);
        const open = t.dependsOn.filter((d) => s.tasks.get(d).status !== "complete");
        if (a.status !== "new" && open.length) throw new Error(`Blocked by incomplete tasks: ${open.join(", ")}`);
        t.status = a.status; return t; } },
    log_issue: { description: "Log an issue against a project.", shape: 1,
      schema: z.object({ projectId: z.string(), summary: z.string(), severity: z.enum(["low", "medium", "high"]).default("medium") }),
      run(a, s) { init(s); if (!s.projects.has(a.projectId)) throw new Error(`Unknown project '${a.projectId}'`);
        const v = { id: uid("iss"), ...a, status: "open" }; s.issues.set(v.id, v); return v; } },
    assign: { description: "Assign a task or issue to a user.", shape: 1, schema: z.object({ kind: z.enum(["task", "issue"]), id: z.string(), assignee: z.string() }),
      run(a, s) { init(s); const item = (a.kind === "task" ? s.tasks : s.issues).get(a.id); if (!item) throw new Error(`Unknown ${a.kind} '${a.id}'`);
        item.assignee = a.assignee; return item; } },
    request_approval: { description: "Request approval from named approvers for a project deliverable.", shape: 1,
      schema: z.object({ projectId: z.string(), deliverable: z.string(), approvers: z.array(z.string()).min(1) }),
      run(a, s) { init(s); if (!s.projects.has(a.projectId)) throw new Error(`Unknown project '${a.projectId}'`);
        const v = { id: uid("apr"), ...a, decisions: {}, status: "pending" }; s.approvals.set(v.id, v); return v; } },
    decide_approval: { description: "Record an approver's decision; approved when all approve, rejected on any rejection.", shape: 1,
      schema: z.object({ approvalId: z.string(), approver: z.string(), decision: z.enum(["approved", "rejected"]), comment: z.string().optional() }),
      run(a, s) { init(s); const p = s.approvals.get(a.approvalId); if (!p) throw new Error(`Unknown approval '${a.approvalId}'`);
        if (!p.approvers.includes(a.approver)) throw new Error(`${a.approver} is not an approver`);
        p.decisions[a.approver] = { decision: a.decision, comment: a.comment };
        p.status = Object.values(p.decisions).some((d) => d.decision === "rejected") ? "rejected" : p.approvers.every((x) => p.decisions[x]) ? "approved" : "pending";
        return p; } },
    project_status: { description: "Campaign-operations rollup: task progress, open issues, approvals.", shape: 1, schema: z.object({ projectId: z.string() }),
      run(a, s) { init(s); const p = s.projects.get(a.projectId); if (!p) throw new Error(`Unknown project '${a.projectId}'`);
        const tasks = [...s.tasks.values()].filter((t) => t.projectId === p.id), done = tasks.filter((t) => t.status === "complete").length;
        return { project: p.name, tasks: tasks.length, complete: done, percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
          openIssues: [...s.issues.values()].filter((i) => i.projectId === p.id && i.status === "open").length,
          approvals: [...s.approvals.values()].filter((x) => x.projectId === p.id).map((x) => ({ deliverable: x.deliverable, status: x.status })) }; } },
  },
});

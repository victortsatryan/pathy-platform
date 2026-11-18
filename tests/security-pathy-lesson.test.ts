import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

import type { Database } from "../src/integrations/supabase/types";
import { canReadLessonDetails, canReadMaterial, canSearchTaskBank, readIsAdmin } from "../src/lib/access-control";
import { isAnswerCorrect } from "../src/lib/answer-check";
import { completeLessonForUser } from "../src/lib/lesson-completion.server";
import {
  getLessonAttemptsForAssignedTasks,
  getMissingRequiredTaskIds,
  isTaskAssignedToLesson,
} from "../src/lib/lesson-security";

const securityMigration = readFileSync(
  new URL("../supabase/migrations/20261118150500_dat04_f05_f06_contract.sql", import.meta.url),
  "utf8",
);

describe("lesson access boundaries", () => {
  it("allows the learner and an actively linked teacher to read a lesson", () => {
    expect(canReadLessonDetails({ viewerId: "student-1", ownerId: "student-1", hasActiveTeacherLink: false })).toBe(true);
    expect(canReadLessonDetails({ viewerId: "teacher-1", ownerId: "student-1", hasActiveTeacherLink: true })).toBe(true);
  });

  it.each([
    ["unrelated student", "student-2", false],
    ["unlinked teacher", "teacher-2", false],
    ["teacher after link is paused", "teacher-1", false],
    ["administrator without a learner link", "admin-1", false],
  ])("denies lesson access to %s", (_role, viewerId, hasActiveTeacherLink) => {
    expect(canReadLessonDetails({ viewerId, ownerId: "student-1", hasActiveTeacherLink })).toBe(false);
  });
});

describe("private material access", () => {
  const privateMaterial = {
    status: "draft",
    isPublic: false,
    createdBy: "teacher-1",
  };

  it("allows the creator and administrator to read private material", () => {
    expect(canReadMaterial({ ...privateMaterial, viewerId: "teacher-1", isAdmin: false })).toBe(true);
    expect(canReadMaterial({ ...privateMaterial, viewerId: "admin-1", isAdmin: true })).toBe(true);
  });

  it.each([
    ["student", "student-1"],
    ["unrelated teacher", "teacher-2"],
    ["linked teacher who did not create it", "teacher-3"],
  ])("denies private material to %s", (_role, viewerId) => {
    expect(canReadMaterial({ ...privateMaterial, viewerId, isAdmin: false })).toBe(false);
  });

  it("allows published public material to authenticated roles", () => {
    expect(canReadMaterial({
      viewerId: "student-1",
      createdBy: "teacher-1",
      status: "published",
      isPublic: true,
      isAdmin: false,
    })).toBe(true);
  });
});

describe("task bank access", () => {
  it("allows administrators and rejects students and teachers", () => {
    expect(canSearchTaskBank(true)).toBe(true);
    expect(canSearchTaskBank(false)).toBe(false);
  });

  it("reads the authoritative admin role, not a client supplied role", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    await expect(
      readIsAdmin({ rpc } as unknown as Pick<SupabaseClient<Database>, "rpc">, "admin-1"),
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("has_role", { _user_id: "admin-1", _role: "admin" });

    const notAdminRpc = vi.fn().mockResolvedValue({ data: false, error: null });
    await expect(
      readIsAdmin({ rpc: notAdminRpc } as unknown as Pick<SupabaseClient<Database>, "rpc">, "teacher-1"),
    ).resolves.toBe(false);
  });
});

describe("lesson task membership and completion", () => {
  it("binds completion to the authenticated identity and delegates all writes to one RPC", async () => {
    const result = { score: 1, max: 1, percent: 100, summary: "ok", already_completed: false };
    const rpc = vi.fn().mockResolvedValue({ data: result, error: null });
    await expect(completeLessonForUser({ rpc }, "authenticated-user", "lesson-id")).resolves.toEqual(result);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("complete_lesson_atomic", {
      p_lesson_id: "lesson-id", p_user_id: "authenticated-user",
    });
  });

  it("fails closed when the RPC is unavailable or rejects the operation", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "RPC unavailable" } });
    await expect(completeLessonForUser({ rpc }, "user", "lesson")).rejects.toThrow("RPC unavailable");
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("accepts only a task assigned to the addressed lesson", () => {
    expect(isTaskAssignedToLesson(["task-1", "task-2"], "task-2")).toBe(true);
    expect(isTaskAssignedToLesson(["task-1", "task-2"], "foreign-task")).toBe(false);
  });

  it("requires each distinct required task rather than a matching attempt count", () => {
    expect(getMissingRequiredTaskIds(["required-a", "required-b"], ["required-a", "required-a"])).toEqual([
      "required-b",
    ]);
    expect(getMissingRequiredTaskIds(["required-a"], ["required-a", "optional-task"])).toEqual([]);
    expect(getMissingRequiredTaskIds([], [])).toEqual([]);
  });

  it("excludes foreign task attempts from a lesson result", () => {
    const attempts = [
      { task_id: "assigned", is_correct: true, validated_by_server: true },
      { task_id: "foreign", is_correct: true, validated_by_server: true },
      { task_id: "assigned", is_correct: true, validated_by_server: false },
      { task_id: null, is_correct: false, validated_by_server: true },
    ];
    expect(getLessonAttemptsForAssignedTasks(["assigned"], attempts)).toEqual([attempts[0]]);
    expect(
      getMissingRequiredTaskIds(
        ["assigned"],
        getLessonAttemptsForAssignedTasks(["assigned"], [attempts[2]]).map((attempt) => attempt.task_id),
      ),
    ).toEqual(["assigned"]);
  });

  it("validates multiple-choice selections on the server as a complete set", () => {
    expect(isAnswerCorrect(["a", "c"], ["c", "a"])).toBe(true);
    expect(isAnswerCorrect(["a", "c"], ["a"])).toBe(false);
    expect(isAnswerCorrect(["a", "c"], ["a", "b", "c"])).toBe(false);
    expect(isAnswerCorrect(["a", "c"], "")).toBeNull();
  });
});

describe("answer-key database contract", () => {
  function authenticatedSelectColumns(table: string): string {
    const statement = securityMigration.match(
      new RegExp(`GRANT SELECT\\s*\\(([^)]*)\\) ON TABLE public\\.${table} TO authenticated;`, "i"),
    );
    expect(statement, `missing safe-column grant for ${table}`).not.toBeNull();
    return statement?.[1] ?? "";
  }

  it("keeps task answer fields out of direct authenticated reads", () => {
    expect(securityMigration).toMatch(/REVOKE ALL ON TABLE public\.tasks FROM PUBLIC, anon, authenticated;/);
    expect(authenticatedSelectColumns("tasks")).not.toMatch(/correct_answer|explanation/i);
    expect(authenticatedSelectColumns("task_attempts")).not.toMatch(/correct_answer/i);
  });

  it("removes direct access to other answer-bearing stores", () => {
    expect(securityMigration).toMatch(/REVOKE ALL ON TABLE public\.content_resources FROM PUBLIC, anon, authenticated;/);
    expect(securityMigration).toMatch(/REVOKE SELECT ON TABLE public\.lesson_overrides FROM PUBLIC, anon, authenticated;/);
    expect(securityMigration).toMatch(/DROP POLICY IF EXISTS "task_solutions read published or own"/);
    expect(securityMigration).toMatch(/CREATE POLICY "task_solutions owner or admin read"/);
  });

  it("limits direct task edits to administrators and disables forged attempts", () => {
    expect(securityMigration).toMatch(/CREATE POLICY "tasks admin manage"[\s\S]*?has_role\(auth\.uid\(\), 'admin'/);
    expect(securityMigration).toMatch(/REVOKE ALL ON TABLE public\.task_attempts FROM PUBLIC, anon, authenticated;/);
    expect(securityMigration).toMatch(/DROP POLICY IF EXISTS "Users can create their own task attempts"/);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  SingleUserModeError,
  UserNotFoundError,
  UsernameTakenError,
  createUser,
  getUserById,
  getUserByUsername,
  listUsers,
  setPassword,
  userCount,
  verifyPassword,
} from "../users.ts";

function makeDb() {
  const configDir = mkdtempSync(join(tmpdir(), "phub-users-"));
  const db = openHubDb(hubDbPath(configDir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

describe("createUser", () => {
  test("creates a user and stores an argon2id hash", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "hunter2");
      expect(u.username).toBe("owner");
      expect(u.id.length).toBeGreaterThan(0);
      // Argon2id encoded form starts with $argon2id$.
      expect(u.passwordHash.startsWith("$argon2id$")).toBe(true);
      expect(u.createdAt).toBe(u.updatedAt);
      expect(userCount(db)).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("refuses a second user without --allow-multi (single-user mode)", async () => {
    const { db, cleanup } = makeDb();
    try {
      await createUser(db, "owner", "pw1");
      await expect(createUser(db, "second", "pw2")).rejects.toThrow(SingleUserModeError);
      expect(userCount(db)).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("allows a second user when allowMulti is true", async () => {
    const { db, cleanup } = makeDb();
    try {
      await createUser(db, "owner", "pw1");
      const second = await createUser(db, "second", "pw2", { allowMulti: true });
      expect(second.username).toBe("second");
      expect(userCount(db)).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("refuses a duplicate username with UsernameTakenError", async () => {
    const { db, cleanup } = makeDb();
    try {
      await createUser(db, "owner", "pw1");
      await expect(createUser(db, "owner", "pw2", { allowMulti: true })).rejects.toThrow(
        UsernameTakenError,
      );
    } finally {
      cleanup();
    }
  });
});

describe("verifyPassword", () => {
  test("true for the original password, false for anything else", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "correct horse");
      expect(await verifyPassword(u, "correct horse")).toBe(true);
      expect(await verifyPassword(u, "wrong")).toBe(false);
      expect(await verifyPassword(u, "")).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("setPassword", () => {
  test("rotates the hash and updates updated_at", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "old-pw");
      const oldHash = u.passwordHash;
      const oldUpdated = u.updatedAt;
      // Bump the clock so the timestamp visibly changes.
      const later = new Date(new Date(oldUpdated).getTime() + 1000);
      await setPassword(db, u.id, "new-pw", () => later);
      const fresh = getUserById(db, u.id);
      expect(fresh).not.toBeNull();
      expect(fresh?.passwordHash).not.toBe(oldHash);
      expect(fresh?.updatedAt).not.toBe(oldUpdated);
      expect(await verifyPassword(fresh!, "new-pw")).toBe(true);
      expect(await verifyPassword(fresh!, "old-pw")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("throws UserNotFoundError for an unknown id", async () => {
    const { db, cleanup } = makeDb();
    try {
      await expect(setPassword(db, "no-such-user", "pw")).rejects.toThrow(UserNotFoundError);
    } finally {
      cleanup();
    }
  });
});

describe("listUsers / getUserByUsername", () => {
  test("listUsers returns rows in created_at order", async () => {
    const { db, cleanup } = makeDb();
    try {
      const a = await createUser(db, "a", "pw", { now: () => new Date(1000) });
      const b = await createUser(db, "b", "pw", {
        allowMulti: true,
        now: () => new Date(2000),
      });
      const list = listUsers(db);
      expect(list.map((u) => u.username)).toEqual([a.username, b.username]);
    } finally {
      cleanup();
    }
  });

  test("getUserByUsername returns null when missing", async () => {
    const { db, cleanup } = makeDb();
    try {
      expect(getUserByUsername(db, "nobody")).toBeNull();
      await createUser(db, "owner", "pw");
      expect(getUserByUsername(db, "owner")?.username).toBe("owner");
    } finally {
      cleanup();
    }
  });
});
